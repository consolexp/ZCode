import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSettingsFacade } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "../../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "../../src/model-provider/providerRuntime.js";

import { WorkbuddyStateStore } from "../../src/workbuddy/state.js";
import { parseCredits } from "../../src/workbuddy/upstream.js";
import { setup, roots, runtimes, cipher, builtin } from "./fixture.js";
import { WorkbuddyRuntime } from "../../src/workbuddy/index.js";

describe("WorkBuddy 国内集成", () => {
  it("思考档位到达真实转发请求，旧无效档位使用上游默认；忙闲失败不丢目录或显示空闲", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    for (const [requested, expected] of [
      ["low", "low"],
      ["max", "max"],
      ["medium", "high"],
    ]) {
      const response = await fetch(`${provider.effectiveConfig.api!.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          input: "E2E_EFFORT",
          reasoning: { effort: requested },
          stream: false,
        }),
      });
      expect(response.status).toBe(200);
      await response.json();
      expect(
        f.calls.filter((call) => call.path.endsWith("/chat/completions")).at(-1)?.body
          ?.reasoning_effort,
      ).toBe(expected);
    }
    f.failBusy();
    const status = await f.execute({ type: "sync-models", providerId: a.providerId });
    expect(status.modelSource).toBe("account");
    expect(status.models?.find((m) => m.id === "deepseek-v4.1-flash")?.busyLevel).toBe("unknown");
    expect(status.modelDetailsUpdatedAt).toBeUndefined();
    expect(status.modelDetailsError).toBeTruthy();
    expect(status.models?.find((m) => m.id === "model-new")?.credits).toBe("x1.5");
  });
  it.each([true, false])("Responses 复用渠道鉴权、401 刷新和积分去重 stream=%s", async (stream) => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    const url = `${provider.effectiveConfig.api!.baseUrl}/responses`;
    const headers = {
      Authorization: `Bearer ${access.apiKey}`,
      "Content-Type": "application/json",
      "x-session-id": "responses-session",
    };
    const body = JSON.stringify({ model: "deepseek-v4.1-flash", input: "hello", stream });
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Authorization: "Bearer wrong" },
          body,
        })
      ).status,
    ).toBe(401);
    f.calls.length = 0;
    f.expireChat();
    const response = await fetch(url, { method: "POST", headers, body });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("read_file");
    expect(text).toContain(stream ? "response.completed" : '"status":"completed"');
    const chatCalls = f.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chatCalls.map((c) => c.authorization)).toEqual([
      "Bearer token-state-1",
      "Bearer token-state-1-refreshed",
    ]);
    expect(f.calls.filter((c) => c.path.endsWith("/auth/token/refresh"))).toHaveLength(1);
    await vi.waitFor(async () =>
      expect(
        (
          await f.execute({
            type: "status",
            providerId: a.providerId,
            sessionId: "responses-session",
          })
        ).usage,
      ).toMatchObject({ credits: 0.25, reportedRequests: 1, unreportedRequests: 0 }),
    );
    expect(f.calls.filter((c) => c.path.includes("billing"))).toHaveLength(0);
  });

  it("不兼容或无效输入返回 400，不调用上游；停用模型仍拒绝", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    const headers = {
      Authorization: `Bearer ${access.apiKey}`,
      "Content-Type": "application/json",
    };
    const base = provider.effectiveConfig.api!.baseUrl!;
    f.calls.length = 0;
    for (const input of [
      { input: "hello", previous_response_id: "old" },
      { input: "hello", background: true },
      { input: "hello", tools: [{ type: "web_search" }] },
      { input: [{ type: "item_reference", id: "old" }] },
      { input: [{ type: "message", role: "user", content: [{ type: "input_audio" }] }] },
      { input: "hello", n: 2 },
    ]) {
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "deepseek-v4.1-flash", ...input }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "unsupported_input" } });
    }
    for (const body of ["{", JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] })]) {
      expect(
        (await fetch(`${base}/chat/completions`, { method: "POST", headers, body })).status,
      ).toBe(400);
    }
    await f.runtime.providerSettings.setPersonalModelEnabled(
      a.providerId,
      "deepseek-v4.1-flash",
      false,
    );
    expect(
      (
        await fetch(`${base}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "deepseek-v4.1-flash", input: "hello" }),
        })
      ).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it("持久化两条独立渠道，授权、模型同步、倍率和配置都进入现有 Provider Registry", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    const b = await f.execute({ type: "create" });
    expect(a.providerId).not.toBe(b.providerId);
    expect(a.modelSource).toBe("snapshot");
    const loggedA = await f.login(a.providerId);
    const loggedB = await f.login(b.providerId);
    expect(loggedA.accountName).not.toBe(loggedB.accountName);
    expect(loggedA.accountName).toBe("test-account-1");
    expect(loggedA.accountId).toBe("test-uid-1");
    expect(loggedA.profileError).toBeUndefined();
    expect(loggedA.models?.find((m) => m.id === "model-new")?.credits).toBe("x1.5");
    expect(loggedA.models?.find((m) => m.id === "model-new")?.contextWindow).toBe(300000);
    expect(loggedA.models?.find((m) => m.id === "model-new")?.contextWindows).toEqual([
      300000, 1000000,
    ]);
    expect(loggedA.models?.find((m) => m.id === "deepseek-v4.1-flash")).toMatchObject({
      descriptionZh: "测试模型说明",
      badges: ["夜间折扣"],
      busyLevel: "idle",
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "max"] },
    });
    expect(loggedA.models?.some((m) => m.id === "image-model")).toBe(false);
    let view = await f.runtime.providerSettings.getView();
    const provider = view.providers.find((p) => p.providerId === a.providerId)!;
    expect(provider.effectiveConfig.integration).toBe("workbuddy-cn");
    expect(provider.effectiveConfig.api?.type).toBe("openai-responses");
    expect(provider.issues).toEqual([]);
    expect(provider.executable).toBe(true);
    expect(provider.models.every((m) => m.executable)).toBe(true);
    expect(
      provider.models.find((m) => m.modelId === "deepseek-v4.1-flash")?.effectiveConfig.optionSpecs
        ?.reasoningLevel?.values,
    ).toEqual(["low", "high", "max"]);
    expect(
      provider.models.find((m) => m.modelId === "model-new")?.effectiveConfig.optionSpecs
        ?.reasoningLevel?.values,
    ).toEqual(["high"]);
    expect(
      provider.models.find((m) => m.modelId === "model-new")?.effectiveConfig.properties
        ?.contextWindow,
    ).toBe(300000);
    await f.runtime.providerSettings.setPersonalModelEnabled(a.providerId, "model-new", false);
    await f.execute({ type: "sync-models", providerId: a.providerId });
    view = await f.runtime.providerSettings.getView();
    expect(
      view.providers
        .find((p) => p.providerId === a.providerId)!
        .models.filter((m) => m.modelId === "model-new"),
    ).toMatchObject([{ enabled: false }]);
    const disk = await readFile(join(f.root, "accounts.enc"), "utf8");
    expect(disk).not.toContain("token-state");
    expect(JSON.stringify(loggedA)).not.toMatch(/accessToken|refreshToken|state-1/);
    f.calls.length = 0;
    await f.execute({ type: "status", providerId: a.providerId });
    expect(f.calls).toHaveLength(0);
  });

  it("旧授权不能覆盖新授权，退出账号清除本地凭据", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    const old = await f.execute({ type: "login", providerId: a.providerId });
    await f.execute({ type: "login", providerId: a.providerId });
    await expect(
      f.execute({ type: "poll", providerId: a.providerId, loginId: old.pendingLogin!.id }),
    ).rejects.toThrow(/过期或取消/);
    await f.login(a.providerId);
    expect((await f.execute({ type: "logout", providerId: a.providerId })).connected).toBe(false);
  });

  it("流式工具调用透传，usage.credit 按会话去重累计，不查询积分余额", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const api = provider.effectiveConfig.api!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    f.calls.length = 0;
    const response = await fetch(`${api.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.apiKey}`,
        "Content-Type": "application/json",
        "x-session-id": "test-session",
      },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("read_file");
    await vi.waitFor(async () => {
      const status = await f.execute({
        type: "status",
        providerId: a.providerId,
        sessionId: "test-session",
      });
      expect(status.usage).toMatchObject({
        credits: 0.25,
        reportedRequests: 1,
        unreportedRequests: 0,
      });
    });
    expect(f.calls.filter((call) => call.path.includes("billing"))).toHaveLength(0);
    const upstream = f.calls.find((call) => call.path.endsWith("/chat/completions"))!;
    expect(upstream.authorization).toBe("Bearer token-state-1");
    const requestId = upstream.headers.get("x-conversation-request-id");
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(upstream.headers.get("x-root-request-id")).toBe(requestId);
    expect(upstream.body?.messages).toMatchObject([{ role: "system" }, { role: "user" }]);
    await f.runtime.providerSettings.deletePersonalProvider(a.providerId);
    await expect(f.execute({ type: "status", providerId: a.providerId })).rejects.toThrow(/删除/);
    expect(
      Object.keys(
        (await new WorkbuddyStateStore(join(f.root, "accounts.enc"), cipher).read()).accounts,
      ),
    ).toHaveLength(0);
  });

  it("上游渠道校验拒绝显示明确原因，不重试且不泄露原始响应", async () => {
    const f = await setup();
    const account = await f.execute({ type: "create" });
    await f.login(account.providerId);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === account.providerId,
    )!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    for (const code of [11128, 12345]) {
      f.rejectChat({ code, msg: "token-state-sensitive" });
      f.calls.length = 0;
      const response = await fetch(`${provider.effectiveConfig.api!.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error.message).toContain(code === 11128 ? "渠道校验" : "HTTP 400");
      expect(JSON.stringify(error)).not.toContain("token-state-sensitive");
      expect(f.calls.filter((call) => call.path.endsWith("/chat/completions"))).toHaveLength(1);
      expect(f.calls.filter((call) => call.path.includes("billing"))).toHaveLength(0);
    }
  });

  it("同步或余额查询失败保留已知数据，不清零", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    f.failCatalog();
    f.failCredits();
    f.failProfile();
    const catalog = await f.execute({ type: "sync-models", providerId: a.providerId });
    expect(catalog.modelSyncError).toBeTruthy();
    expect(catalog.modelSource).toBe("account");
    expect(catalog.models?.some((model) => model.id === "model-new")).toBe(true);
    const refreshed = await f.execute({ type: "refresh", providerId: a.providerId });
    expect(refreshed.benefits?.credits?.remaining).toBe(123.5);
    expect(refreshed.benefits?.creditsError).toBeTruthy();
    expect(refreshed.accountName).toBe("test-account-1");
    expect(refreshed.profileError).toBeTruthy();
  });

  it("损坏账号文件拒绝覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-wb-corrupt-"));
    roots.push(root);
    const path = join(root, "accounts.enc");
    await writeFile(path, "broken");
    const store = new WorkbuddyStateStore(path, cipher);
    await expect(store.update(async () => {})).rejects.toThrow(/不可读取/);
    expect(await readFile(path, "utf8")).toBe("broken");
  });

  it("启动就绪不等待后台签到网络请求", async () => {
    const f = await setup();
    const runtime = new WorkbuddyRuntime({
      filePath: join(f.root, "accounts.enc"),
      cipher,
      fetcher: f.fetcher,
      settings: new ProviderSettingsFacade(f.runtime.registryService),
    });
    const tick = vi.spyOn(runtime, "tick").mockReturnValue(new Promise<void>(() => {}));
    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(tick).toHaveBeenCalledOnce();
    } finally {
      runtime.dispose();
    }
  });

  it("多窗口并发自动签到只尝试一次；同日状态读取不查询余额", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const settings = new ProviderSettingsFacade(f.runtime.registryService);
    const options = {
      filePath: join(f.root, "accounts.enc"),
      cipher,
      fetcher: f.fetcher,
      settings,
    };
    const one = new WorkbuddyRuntime(options),
      two = new WorkbuddyRuntime(options);
    try {
      f.calls.length = 0;
      await Promise.all([one.tick(), two.tick()]);
      expect(f.calls.filter((call) => call.path.endsWith("daily-checkin"))).toHaveLength(1);
      f.calls.length = 0;
      await Promise.all([one.tick(), two.tick()]);
      expect(f.calls).toHaveLength(0);
      expect(
        (await f.execute({ type: "status", providerId: a.providerId })).benefits?.checkin
          ?.todayCheckedIn,
      ).toBe(true);
    } finally {
      one.dispose();
      two.dispose();
    }
  });

  it("领取结果不确定时不自动或并发重发；停用渠道不会签到", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    f.failClaim();
    await Promise.all([
      f.execute({ type: "checkin", providerId: a.providerId }),
      f.execute({ type: "checkin", providerId: a.providerId }),
    ]);
    expect(f.calls.filter((call) => call.path.endsWith("daily-checkin"))).toHaveLength(1);
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    await f.runtime.providerSettings.savePersonalProviderOverlay(
      a.providerId,
      provider.personalConfig!,
      { enabled: false },
    );
    const other = new WorkbuddyRuntime({
      filePath: join(f.root, "accounts.enc"),
      cipher,
      fetcher: f.fetcher,
      settings: new ProviderSettingsFacade(f.runtime.registryService),
    });
    try {
      f.calls.length = 0;
      await other.tick();
      expect(f.calls).toHaveLength(0);
    } finally {
      other.dispose();
    }
  });

  it("重启迁移旧 WorkBuddy Chat 配置为 Responses，保留账号、端口和个人设置且只写一次", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    await f.login(a.providerId);
    const oldProvider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const plain = await f.runtime.providerSettings.createPersonalProvider({
      providerName: "普通 Chat 渠道",
      initialConfig: {
        api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
      },
    });
    await f.runtime.providerSettings.savePersonalProviderOverlay(
      a.providerId,
      {
        ...oldProvider.personalConfig!,
        api: { ...oldProvider.effectiveConfig.api!, type: "openai-chat-completions" },
      },
      { providerName: "保留名称" },
    );
    await f.runtime.providerSettings.setPersonalModelEnabled(a.providerId, "model-new", false);
    f.runtime.dispose();
    const next = createProviderRuntimeFromConfigRuntime({
      configRuntime: createProviderConfigRuntime({
        zcodeBuiltinFilePath: builtin,
        personalFilePath: join(f.root, "personal.json"),
        watch: false,
        personalPollingIntervalMs: false,
      }),
      workbuddy: { filePath: join(f.root, "accounts.enc"), cipher, fetcher: f.fetcher },
    });
    runtimes.push(next);
    await next.start();
    const restored = await next.providerSettings.workbuddy!({
      type: "status",
      providerId: a.providerId,
    });
    expect(restored.connected).toBe(true);
    const provider = (await next.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    expect(provider.effectiveConfig.api?.baseUrl).toBe(oldProvider.effectiveConfig.api?.baseUrl);
    expect(provider.effectiveConfig.api?.type).toBe("openai-responses");
    expect(provider.providerName).toBe("保留名称");
    expect(provider.effectiveConfig.access).toEqual(oldProvider.effectiveConfig.access);
    expect(provider.models.find((m) => m.modelId === "model-new")?.enabled).toBe(false);
    expect(
      (await next.providerSettings.getView()).providers.find(
        (p) => p.providerId === plain.providerId,
      )?.effectiveConfig.api?.type,
    ).toBe("openai-chat-completions");
    const settings = new ProviderSettingsFacade(next.registryService);
    const save = vi.spyOn(settings, "savePersonalProviderOverlay");
    const other = new WorkbuddyRuntime({
      filePath: join(f.root, "accounts.enc"),
      cipher,
      fetcher: f.fetcher,
      settings,
    });
    try {
      await other.start();
      expect(save).not.toHaveBeenCalled();
    } finally {
      other.dispose();
    }
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    const response = await fetch(`${provider.effectiveConfig.api!.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.apiKey}`,
        "Content-Type": "application/json",
        "x-session-id": "prefixed-session",
      },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.tool_calls[0].function.name).toBe(
      "read_file",
    );
    await vi.waitFor(async () => {
      expect(
        (
          await next.providerSettings.workbuddy!({
            type: "status",
            providerId: a.providerId,
            sessionId: "sess_prefixed-session",
          })
        ).usage?.credits,
      ).toBe(0.25);
    });
  });

  it("积分只统计当前有效资源包，优先使用本周期精确余额", () => {
    const now = Date.parse("2026-10-27T00:00:00+08:00");
    expect(
      parseCredits(
        [
          { Status: 0, CycleCapacityRemainPrecise: "10.25", CapacityRemain: 100 },
          { Status: 0, CapacityRemain: 30, ExpiredTime: "2026-10-26 23:59:59" },
          { Status: 3, CapacityRemain: 50 },
        ],
        now,
      ).remaining,
    ).toBe(10.25);
  });
});
