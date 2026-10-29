import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import { createProviderConfigRuntime } from "../../src/model-provider/providerConfigRuntime.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "../../src/model-provider/providerRuntime.js";
import { createCredentialCipherProvider } from "../../src/credential/providers/credentialCipherProvider.js";
export const roots: string[] = [];
export const runtimes: ProviderRuntime[] = [];
export const cipher = createCredentialCipherProvider({
  env: { ZCODE_CREDENTIAL_SECRET: "workbuddy-test-only" },
});
export const builtin = fileURLToPath(
  new URL("../../../../config/provider/zcode-builtin.json", import.meta.url),
);

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zcode-wb-"));
  roots.push(root);
  const calls: {
    path: string;
    authorization?: string;
    body?: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  let checkedIn = false;
  let loginCount = 0;
  let failCatalog = false;
  let failCredits = false;
  let failClaim = false;
  let failProfile = false;
  let failBusy = false;
  let failMetadata = false;
  let chatRejectAccount: string | undefined;
  let chatErrorFormat = "http";
  let chatError: unknown;
  let unauthorizedOnce = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, authorization, body, headers: new Headers(init?.headers) });
    let data: unknown;
    if (path.endsWith("/auth/state")) {
      loginCount++;
      data = { state: `state-${loginCount}`, authUrl: "https://www.workbuddy.cn/login/test" };
    } else if (path.endsWith("/auth/token/refresh"))
      data = {
        accessToken: `${authorization?.slice(7)}-refreshed`,
        refreshToken: "refresh-test",
        expiresIn: 3600,
      };
    else if (path.endsWith("/auth/token"))
      data = {
        accessToken: `token-${new URL(String(input)).searchParams.get("state")}`,
        refreshToken: "refresh-test",
        expiresIn: 3600,
      };
    else if (path === "/v2/accounts") {
      if (failProfile) return new Response("", { status: 503 });
      const identity = authorization?.match(/token-state-(\d+)/)?.[1];
      data = {
        accounts: [
          { uid: "enterprise-only", nickname: "wrong enterprise", type: "enterprise" },
          { uid: `test-uid-${identity}`, nickname: `test-account-${identity}`, type: "personal" },
        ],
      };
    } else if (path.endsWith("/models")) {
      if (failCatalog) return new Response("", { status: 503 });
      data = {
        models: [
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek",
            credits: "x0.25",
            descriptionZh: "测试模型说明",
            tags: ["badge:夜间折扣:#1E90FF"],
            reasoning: {
              defaultEffort: "high",
              supportedEfforts: ["low", "high", "max"],
              canDisableThinking: true,
            },
          },
          {
            id: "model-new",
            credits: "x1.5",
            contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] },
            reasoning: { effort: "high" },
          },
          { id: "image-model", tags: ["text-to-image"] },
        ],
        agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "model-new", "image-model"] }],
      };
    } else if (path === "/v3/config") {
      if (failMetadata) return new Response("", { status: 503 });
      data = {
        modelPromotions: [
          {
            id: "e2e-free",
            enabled: true,
            kind: "discount",
            modelIds: ["model-new"],
            badge: {
              label: "限时免费",
              color: "#009273",
              icon: "data:image/svg+xml;base64,PHN2Zy8+",
            },
            discount: { discountedCredits: "0x", factor: 0, displayMode: "replace" },
          },
        ],
        modelTiers: [
          {
            id: "tier-test",
            modelIds: ["model-new"],
            badge: { label: "订阅优先" },
            requiredUserType: "standard",
            tier: "standard",
          },
        ],
      };
    } else if (path === "/v2/chat/busy") {
      if (failBusy) return new Response("", { status: 503 });
      data = [{ model: "deepseek-v4.1-flash", busy_level: "idle" }];
    } else if (path.endsWith("get-user-resource")) {
      if (failCredits) return new Response("", { status: 503 });
      data = {
        Response: {
          Data: {
            Accounts: [
              {
                Status: 0,
                PackageName: "test",
                CycleCapacityRemain: "123.5",
                CapacityUnit: "credits",
              },
            ],
            TotalCount: 1,
          },
        },
      };
    } else if (path.endsWith("checkin-activity-status"))
      data = { active: true, today_checked_in: checkedIn, streak_days: 2, total_credits: 15 };
    else if (path.endsWith("daily-checkin")) {
      if (failClaim) throw new TypeError("simulated ambiguous network failure");
      checkedIn = true;
      data = { credit: 5 };
    } else if (path.endsWith("/chat/completions")) {
      if (unauthorizedOnce) {
        unauthorizedOnce = false;
        return new Response("", { status: 401 });
      }
      if (chatError && (!chatRejectAccount || authorization === chatRejectAccount)) {
        if (chatErrorFormat === "sse")
          return new Response(`: heartbeat\n\ndata: ${JSON.stringify(chatError)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        return Response.json(chatError, {
          status:
            chatErrorFormat === "json"
              ? 200
              : (chatError as { code?: number }).code === 6004
                ? 429
                : 400,
        });
      }
      return new Response(
        [
          {
            id: "chat-test",
            model: body?.model,
            choices: [
              {
                index: 0,
                delta: {
                  content: "hello",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-test",
                      type: "function",
                      function: { name: "read_file", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: "chat-test",
            model: body?.model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, credit: 0.25 },
          },
          { id: "chat-test", choices: [], usage: { credit: 0.25 } },
        ]
          .map((packet) => `data: ${JSON.stringify(packet)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } else throw new Error(`unexpected test path ${path}`);
    return Response.json({ code: 0, data });
  });
  const configRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: builtin,
    personalFilePath: join(root, "personal.json"),
    watch: false,
    personalPollingIntervalMs: false,
  });
  const runtime = createProviderRuntimeFromConfigRuntime({
    configRuntime,
    workbuddy: { filePath: join(root, "accounts.enc"), cipher, fetcher },
  });
  runtimes.push(runtime);
  await runtime.start();
  const execute = runtime.providerSettings.workbuddy!;
  const login = async (providerId: string) => {
    const pending = await execute({ type: "login", providerId });
    return execute({ type: "poll", providerId, loginId: pending.pendingLogin!.id });
  };
  return {
    root,
    runtime,
    execute,
    login,
    calls,
    fetcher,
    failClaim: () => {
      failClaim = true;
    },
    failCatalog: () => {
      failCatalog = true;
    },
    failCredits: () => {
      failCredits = true;
    },
    failProfile: () => {
      failProfile = true;
    },
    failBusy: () => {
      failBusy = true;
    },
    failMetadata: () => {
      failMetadata = true;
    },
    rejectChat: (error: unknown, account?: string, format = "http") => {
      chatError = error;
      chatRejectAccount = account;
      chatErrorFormat = format;
    },
    expireChat: () => {
      unauthorizedOnce = true;
    },
  };
}
