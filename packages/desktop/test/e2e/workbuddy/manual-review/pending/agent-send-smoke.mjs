// Run from repository root after building both desktop and its bundled Agent.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

const requests = [];
const marker = "E2E_WORKBUDDY_AGENT_REPLY";
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({
    model: body.model,
    main: JSON.stringify(body.input ?? []).includes("E2E_WORKBUDDY_SEND"),
    responses: req.url === "/v1/responses",
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const reasoning = {
    id: "rs_e2e",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "E2E_WORKBUDDY_THOUGHT" }],
  };
  const message = {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }],
  };
  const response = {
    id: "resp_e2e",
    object: "response",
    created_at: 1,
    model: body.model,
    status: "in_progress",
    output: [],
  };
  let sequence = 0;
  const send = (type, data) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
    );
  send("response.created", { response });
  send("response.in_progress", { response });
  send("response.output_item.added", { output_index: 0, item: { ...reasoning, summary: [] } });
  const thought = { item_id: reasoning.id, output_index: 0, summary_index: 0 };
  send("response.reasoning_summary_part.added", {
    ...thought,
    part: { type: "summary_text", text: "" },
  });
  for (const delta of ["E2E_", "WORKBUDDY_", "THOUGHT"])
    send("response.reasoning_summary_text.delta", { ...thought, delta });
  send("response.reasoning_summary_text.done", { ...thought, text: reasoning.summary[0].text });
  send("response.reasoning_summary_part.done", { ...thought, part: reasoning.summary[0] });
  send("response.output_item.done", { output_index: 0, item: reasoning });
  send("response.output_item.added", {
    output_index: 1,
    item: { ...message, status: "in_progress", content: [] },
  });
  const text = { item_id: message.id, output_index: 1, content_index: 0 };
  send("response.content_part.added", {
    ...text,
    part: { type: "output_text", text: "", annotations: [] },
  });
  send("response.output_text.delta", { ...text, delta: marker });
  send("response.output_text.done", { ...text, text: marker });
  send("response.content_part.done", { ...text, part: message.content[0] });
  send("response.output_item.done", { output_index: 1, item: message });
  send("response.completed", {
    response: {
      ...response,
      status: "completed",
      output: [reasoning, message],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  res.end();
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const artifacts = resolve(".run-logs");
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, "workbuddy-agent-e2e-"));
const data = join(profile, "data");
const configDir = join(data, ".zcode", "v2");
await mkdir(configDir, { recursive: true });
// 冷启动前播种合成渠道，真实 Agent 必须接受与桌面相同的 integration schema。
await writeFile(
  join(configDir, "provider_config.json"),
  JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "e2e-workbuddy",
            providerName: "E2E WorkBuddy",
            enabled: true,
            config: {
              integration: "workbuddy-cn",
              group: "standard-personal",
              access: { type: "api-key", apiKey: "E2E_ONLY" },
              api: {
                type: "openai-chat-completions",
                baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
              },
              personalModelIds: ["hy3"],
              modelOrder: ["hy3"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: "e2e-workbuddy", modelId: "hy3", config: { enabled: true } },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: "e2e-workbuddy", modelId: "hy3" },
    },
  }),
);
const env = {
  ...process.env,
  ZCODE_ENV: "production",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DATA_BASE_DIR: data,
  ZCODE_DESKTOP_HOME_DIR: data,
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = resolve(
  "node_modules/electron/dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron",
);
let app;
try {
  app = await _electron.launch({ executablePath, args: [resolve("packages/desktop")], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByTestId("login-use-api-key-button").click();
  await page.getByTestId("login-api-key-skip-button").click();
  const input = page.getByTestId("v4-composer-input");
  await input.fill("E2E_WORKBUDDY_SEND reply with the fixed marker only");
  await page.getByTestId("v4-composer-send").click();
  await page.getByText(marker, { exact: true }).first().waitFor({ timeout: 60_000 });
  assert.ok(
    requests.some((request) => request.model === "hy3" && request.main && request.responses),
  );
  const closedHistory = page.locator(
    '[data-testid^="chat-assistant-history-trigger"][data-history-open="false"]',
  );
  if (await closedHistory.count()) await closedHistory.first().click();
  const reasoningRows = page.getByTestId("chat-reasoning-trigger");
  await reasoningRows.first().waitFor();
  assert.equal(await reasoningRows.count(), 1, "三段思考增量只能生成一条思考记录");
  await page.screenshot({ path: join(profile, "agent-reply.png") });
  await writeFile(
    join(profile, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        synthetic: true,
        actualBundledAgent: true,
        realAccountVerified: false,
        mainRequestReceived: true,
        apiType: "openai-responses",
        reasoningRows: 1,
      },
      null,
      2,
    ),
  );
  console.log(`WorkBuddy bundled Agent send passed: ${profile}`);
} finally {
  await app?.close();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
}
