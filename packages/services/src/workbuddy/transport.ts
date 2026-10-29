import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { z } from "zod";
import { createWorkbuddy, type UpstreamResponse } from "./vendor/wb-proxy.mjs";
// 桌面 Host 打包为 ESM；协议入口使用静态导入，避免内置模块 require 在启动时崩溃。
import * as protocol from "./vendor/protocol.mjs";
import { readJson, WORKBUDDY_ORIGIN, type WorkbuddyAuth } from "./upstream.js";

const MAX_BYTES = 16 * 1024 * 1024;

export function isModelDailyLimit(value: unknown): boolean {
  const code = z.union([z.literal(6004), z.literal("6004")]);
  return z.union([z.object({ code }), z.object({ error: z.object({ code }) })]).safeParse(value)
    .success;
}

async function upstreamStream(response: Response): Promise<Readable & { statusCode: number }> {
  if (!response.ok || response.headers.get("Content-Type")?.includes("application/json")) {
    const error = await readJson(response).catch(() => undefined);
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(error ?? {}))]), {
      statusCode: response.ok && isModelDailyLimit(error) ? 429 : response.status,
    });
  }
  const stream = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
  const iterator = stream[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let size = 0;
  let text = "";
  // 6004 也可能作为首个 SSE 错误事件返回200；仅在任何成功事件前识别，禁止重放已输出的流。
  while (size < 65536) {
    const chunk = await iterator.next();
    if (chunk.done) break;
    const buffer = Buffer.from(chunk.value);
    prefix.push(buffer);
    size += buffer.length;
    text = Buffer.concat(prefix).toString("utf8").replace(/\r\n/g, "\n");
    const packets = text.split("\n\n").slice(0, -1);
    const first = packets
      .map((packet) =>
        packet
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .find(Boolean);
    if (!first) continue;
    try {
      if (isModelDailyLimit(JSON.parse(first))) {
        stream.destroy();
        return Object.assign(Readable.from([Buffer.from(first)]), { statusCode: 429 });
      }
    } catch {
      /* 首个非业务错误事件原样交给协议兼容层。 */
    }
    break;
  }
  return Object.assign(
    Readable.from(
      (async function* () {
        try {
          yield* prefix;
          for (;;) {
            const chunk = await iterator.next();
            if (chunk.done) break;
            yield chunk.value;
          }
        } finally {
          stream.destroy();
        }
      })(),
    ),
    { statusCode: response.status },
  );
}

// worker.js 的 Capture 边界：承接原始 handleChat，不更改上游的流处理代码。
class Capture extends PassThrough {
  statusCode = 200;
  readonly head: Promise<void>;
  #resolve!: () => void;
  #reject!: (error: Error) => void;

  constructor() {
    super();
    this.head = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.on("error", (error) => this.#reject(error));
  }

  writeHead(status: number) {
    this.statusCode = status;
    this.#resolve();
    return this;
  }
}

export function createChatTransport(options: {
  fetcher: typeof fetch;
  signal: AbortSignal;
  withAuthRetry(
    fn: (auth: WorkbuddyAuth) => Promise<UpstreamResponse>,
  ): Promise<{ up: UpstreamResponse }>;
}) {
  const wb = createWorkbuddy({
    endpoint: WORKBUDDY_ORIGIN,
    withAuthRetry: options.withAuthRetry,
    request: async (url, init) => {
      const response = await options.fetcher(url, {
        ...init,
        redirect: "error",
        signal: options.signal,
      });
      // 上游 readAll 不限大小；错误体沿用 ZCode 的有界读取，避免异常响应耗尽内存。
      return upstreamStream(response);
    },
  });
  return {
    request(
      input: unknown,
      responses: boolean,
    ): Record<string, unknown> & { model: string; stream: boolean } {
      const body = z.record(z.string(), z.unknown()).parse(input);
      const model = z.string().min(1).parse(body.model);
      if (body.stream !== undefined) z.boolean().parse(body.stream);
      if (body.n !== undefined && body.n !== 1) throw new Error("仅支持一个回答。");
      const chat = responses ? protocol.responseRequest(wb, body) : { ...body };
      z.array(z.record(z.string(), z.unknown())).min(1).parse(chat.messages);
      if (chat.tools !== undefined)
        for (const tool of z.array(z.record(z.string(), z.unknown())).parse(chat.tools)) {
          z.literal("function").parse(tool.type);
          z.object({ name: z.string().min(1) }).parse(tool.function);
        }
      return { ...chat, model, stream: body.stream === true };
    },
    async relay(
      body: Record<string, unknown> & { model: string; stream: boolean },
      res: ServerResponse,
      responses: boolean,
      onCredit: (credit: number) => Promise<void>,
    ) {
      const capture = new Capture();
      const req = new EventEmitter();
      const cancel = () => {
        req.emit("close");
        capture.destroy(new Error("WorkBuddy 客户端已断开。"));
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (options.signal.aborted) throw new Error("WorkBuddy 请求已取消。");
        void wb
          .handleChat(req, capture, JSON.stringify({ ...body, stream: true }))
          .catch((error) => capture.destroy(error));
        await capture.head;
        if (capture.statusCode >= 400) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of capture) {
            size += chunk.length;
            if (size > MAX_BYTES) throw new Error("WorkBuddy 错误响应过大。");
            chunks.push(chunk);
          }
          const failed = z
            .object({ error: z.object({ detail: z.string().optional() }) })
            .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          let channelRejected = false;
          if (capture.statusCode === 400 && failed.success && failed.data.error.detail) {
            try {
              channelRejected = z
                .object({ code: z.literal(11128) })
                .safeParse(JSON.parse(failed.data.error.detail)).success;
            } catch {
              /* 仅识别结构化业务码，其他错误不回传上游内容。 */
            }
          }
          res.writeHead(capture.statusCode, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: channelRejected
                  ? "WorkBuddy 上游返回 HTTP 400：渠道校验未通过（11128）。"
                  : `WorkBuddy 上游返回 HTTP ${capture.statusCode}。`,
              },
            }),
          );
          return;
        }
        // 协议层原样使用；积分投影留在外侧，避免 fork 上游 relay。
        async function* tracked() {
          for await (const packet of protocol.events(capture)) {
            const credit = packet.event?.usage?.credit;
            if (typeof credit === "number" && Number.isFinite(credit) && credit >= 0)
              await onCredit(credit);
            yield Buffer.from(`data: ${packet.done ? "[DONE]" : JSON.stringify(packet.event)}\n\n`);
          }
        }
        await protocol.relay(tracked(), res, {
          wb,
          alias: body.model,
          expected: body.model,
          responses,
          stream: body.stream,
        });
      } finally {
        options.signal.removeEventListener("abort", cancel);
        req.emit("close");
        capture.destroy();
      }
    },
  };
}
