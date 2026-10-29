import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const vendor = new URL("../../src/workbuddy/vendor/", import.meta.url);
const hash = (source: string) =>
  createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");

describe("WorkBuddy 上游核心保持原样", () => {
  it.each(["cjs", "esm"] as const)(
    "%s 打包后无需访问源码或外部仓库即可调用协议层",
    async (format) => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-wb-bundle-"));
      try {
        const outfile = join(directory, format === "esm" ? "smoke.mjs" : "smoke.cjs");
        await build({
          stdin: {
            contents: `import { createChatTransport } from './packages/services/src/workbuddy/transport.ts';
          const transport = createChatTransport({fetcher: fetch, signal: new AbortController().signal, withAuthRetry: async () => {throw new Error('unexpected network');}});
          process.stdout.write(JSON.stringify(transport.request({model:'test-model',input:'hello'}, true)));`,
            resolveDir: process.cwd(),
          },
          bundle: true,
          platform: "node",
          format,
          outfile,
        });
        const { stdout } = await promisify(execFile)(process.execPath, [outfile]);
        expect(JSON.parse(stdout)).toMatchObject({
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("protocol 去掉 ESM 导入导出补丁后与原始快照逐字一致", async () => {
    const source = (await readFile(new URL("protocol.mjs", vendor), "utf8"))
      .replaceAll("\r\n", "\n")
      .replace("import crypto from 'node:crypto';", "var crypto = require('node:crypto');")
      .replace(
        "import { StringDecoder } from 'node:string_decoder';",
        "var StringDecoder = require('node:string_decoder').StringDecoder;",
      )
      .replace(
        "export { responseRequest, relay, events, modelMatches };",
        "module.exports = { responseRequest: responseRequest, relay: relay, events: events, modelMatches: modelMatches };",
      );
    expect(hash(source)).toBe("7e5794f4bcc69542c7b209e08e5f6dd0621447cf0a414d526f20ec5a3fa25e90");
  });

  it("wb-proxy 去掉嵌入补丁后与原始快照逐字一致", async () => {
    const source = (await readFile(new URL("wb-proxy.mjs", vendor), "utf8"))
      .replaceAll("\r\n", "\n")
      .replace(
        "// ZCode embedding: isolate endpoint, authentication and network IO per adapter instance.\nexport function createWorkbuddy(embedding) {\nconst ENDPOINT = embedding.endpoint;",
        "const ENDPOINT = process.env.WB_ENDPOINT || 'https://www.workbuddy.ai';",
      )
      .replace("  if (embedding.request) return embedding.request(urlStr, opts);\n", "")
      .replace("  if (embedding.withAuthRetry) return embedding.withAuthRetry(fn);\n", "")
      .replace(
        "// ---------------- main ----------------\n\nfunction main() {",
        "// ---------------- main ----------------\n",
      )
      .replace(
        "}\nreturn { handleChat, responsesToChat, chatToResponseObject, mapUsage };\n}\n",
        "",
      );
    expect(hash(source)).toBe("c2c71113261cee9b362497d45f5988e73e7c1ddd671eb953681ceada7d870652");
  });
});
