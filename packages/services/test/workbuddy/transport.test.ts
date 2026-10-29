import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { createChatTransport } from "../../src/workbuddy/transport.js";

const model = "deepseek-v4.1-flash";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const packet = (delta = {}, finish_reason: string | null = null, actualModel = model) => ({
  id: "chat-test",
  created: 1,
  model: actualModel,
  choices: [{ index: 0, delta, finish_reason }],
});
const sse = (packets: unknown[], end = true) =>
  packets.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join("") +
  (end ? "data: [DONE]\r\n\r\n" : "");

async function setup(source: string | ((signal: AbortSignal) => Response)) {
  const credits: number[] = [];
  const requests: { body: Record<string, unknown>; headers: Headers; signal: AbortSignal }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_, init) => {
    requests.push({
      body: JSON.parse(String(init!.body)),
      headers: new Headers(init!.headers),
      signal: init!.signal!,
    });
    return typeof source === "string" ? new Response(source) : source(init!.signal!);
  });
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const transport = createChatTransport({
      fetcher,
      signal: controller.signal,
      withAuthRetry: async (send) => ({
        up: await send({ accessToken: "test-token", account: { uid: "test-user" } }),
      }),
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const responses = req.url!.endsWith("responses");
      const body = transport.request(JSON.parse(Buffer.concat(chunks).toString()), responses);
      await transport.relay(body, res, responses, async (credit) => {
        credits.push(credit);
      });
    } catch {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502);
        res.end("failed");
      }
    } finally {
      controller.abort();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    credits,
    requests,
    fetcher,
    send: (body: Record<string, unknown>, responses = true) =>
      fetch(`http://127.0.0.1:${address.port}/${responses ? "responses" : "chat/completions"}`, {
        method: "POST",
        body: JSON.stringify({ model, ...body }),
      }),
  };
}

describe("原始 WorkBuddy 核心与协议桥接", () => {
  it.each([false, true])(
    "真实 Responses SDK 消费空工具列表的思考分片，只产生一个思考段，后续工具=%s",
    async (tools) => {
      const f = await setup(
        sse([
          ...["先", "分析", "完成"].map((reasoning_content) =>
            packet({ content: "", reasoning_content, tool_calls: [] }),
          ),
          tools
            ? packet(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-test",
                      type: "function",
                      function: { name: "read", arguments: "{}" },
                    },
                  ],
                },
                "tool_calls",
              )
            : packet({ content: "结果", reasoning_content: "", tool_calls: [] }, "stop"),
        ]),
      );
      const provider = createOpenAI({ apiKey: "test", baseURL: f.baseUrl });
      const { stream } = await provider
        .responses(model)
        .doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
      const events = await Array.fromAsync(stream);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.filter((e) => e.type === "reasoning-start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "reasoning-end")).toHaveLength(1);
      expect(
        events
          .filter((e) => e.type === "reasoning-delta")
          .map((e) => e.delta)
          .join(""),
      ).toBe("先分析完成");
      if (tools)
        expect(events.filter((e) => e.type === "tool-call")).toMatchObject([
          { toolCallId: "call-test", toolName: "read", input: "{}" },
        ]);
      else
        expect(
          events
            .filter((e) => e.type === "text-delta")
            .map((e) => e.delta)
            .join(""),
        ).toBe("结果");
    },
  );

  it.each([true, false])("Responses 文本、思考和并行工具完整输出 stream=%s", async (stream) => {
    const f = await setup(
      sse([
        packet({
          reasoning_content: "think",
          content: "你好",
          tool_calls: [
            { index: 0, id: "call-a", function: { name: "read", arguments: "{" } },
            { index: 1, id: "call-b", function: { name: "list", arguments: "{}" } },
          ],
        }),
        packet({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }, "tool_calls"),
        {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, credit: 0.25 },
        },
      ]),
    );
    const response = await f.send({ input: "hello", stream });
    expect(response.status).toBe(200);
    if (stream) {
      const text = await response.text();
      expect(text).toContain("response.reasoning_summary_text.delta");
      expect(text).toContain("response.output_text.delta");
      expect(text).toContain("response.function_call_arguments.done");
      const completed = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === "response.completed");
      expect(completed.response.output).toMatchObject([
        { type: "reasoning", summary: [{ text: "think" }] },
        { type: "message", content: [{ text: "你好" }] },
        { type: "function_call", call_id: "call-a", name: "read", arguments: "{}" },
        { type: "function_call", call_id: "call-b", name: "list", arguments: "{}" },
      ]);
      expect(completed.response.usage.total_tokens).toBe(15);
    } else {
      expect(await response.json()).toMatchObject({
        status: "completed",
        model,
        usage: { input_tokens: 10, total_tokens: 15 },
        output: [
          { type: "reasoning" },
          { type: "message" },
          { type: "function_call", name: "read", arguments: "{}" },
          { type: "function_call", name: "list", arguments: "{}" },
        ],
      });
    }
    expect(f.credits).toEqual([0.25]);
    expect(f.requests[0]!.body).toMatchObject({
      stream: true,
      messages: [{ role: "system" }, { role: "user" }],
    });
    expect(f.requests[0]!.headers.get("x-user-id")).toBe("test-user");
  });

  it("Responses 历史、图片、工具与参数交由原始转换器处理", async () => {
    const f = await setup(sse([packet({ content: "ok" }, "stop")]));
    await (
      await f.send({
        instructions: "rules",
        input: [
          { type: "message", role: "developer", content: "more rules" },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "see" },
              { type: "input_image", image_url: "https://example.test/image.png" },
            ],
          },
          { type: "function_call", call_id: "a", name: "read", arguments: "{}" },
          { type: "function_call", call_id: "b", name: "list", arguments: "{}" },
          { type: "function_call_output", call_id: "a", output: "result" },
        ],
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        reasoning: { effort: "high" },
        parallel_tool_calls: false,
        max_output_tokens: 50,
        text: { format: { type: "json_object" } },
      })
    ).text();
    expect(f.requests[0]!.body).toMatchObject({
      messages: [
        { role: "system", content: "rules" },
        { role: "system", content: "more rules" },
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "https://example.test/image.png" } },
          ],
        },
        { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
        { role: "tool", tool_call_id: "a", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
      reasoning_effort: "high",
      parallel_tool_calls: false,
      max_tokens: 50,
      response_format: { type: "json_object" },
    });
  });

  it.each([true, false])("length 完成原因返回 incomplete stream=%s", async (stream) => {
    const f = await setup(sse([packet({ content: "partial" }, "length")]));
    const response = await f.send({ input: "hello", stream });
    const text = await response.text();
    expect(text).toContain(stream ? "response.incomplete" : '"status":"incomplete"');
    expect(text).toContain("max_output_tokens");
    expect(text).not.toContain("response.completed");
  });

  it.each([
    sse([packet({ content: "wrong" }, "stop", "wrong-model")]),
    sse([{ choices: [{ delta: { content: "no model" }, finish_reason: "stop" }] }]),
    sse([packet({ content: "unfinished" })]),
    sse([packet({}, "unknown")]),
    sse([packet({}, "stop")], false) + "data: {",
  ])("错模型、缺模型、未完成和截断不得报告成功", async (source) => {
    const f = await setup(source);
    const response = await f.send({ input: "hello" });
    expect(response.status).toBe(502);
  });

  it("日期后缀模型校验通过，Chat 输出保持请求模型名", async () => {
    const f = await setup(sse([packet({ content: "ok" }, "stop", `${model}-2026-10-28`)]));
    const response = await f.send(
      { messages: [{ role: "developer", content: "rules" }], stream: false },
      false,
    );
    expect(await response.json()).toMatchObject({
      model,
      choices: [{ message: { content: "ok" } }],
    });
    expect(f.requests[0]!.body.messages).toEqual([{ role: "system", content: "rules" }]);
  });

  it("客户端断开取消同一个上游请求", async () => {
    let cancelled = false;
    const f = await setup(
      (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(sse([packet({ content: "hello" })], false)),
              );
              signal.addEventListener("abort", () => {
                cancelled = true;
                controller.error(new Error("aborted"));
              });
            },
          }),
        ),
    );
    const response = await f.send({ input: "hello", stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(f.requests[0]!.signal.aborted).toBe(true);
  });
});
