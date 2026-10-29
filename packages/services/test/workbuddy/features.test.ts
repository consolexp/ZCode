import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { WorkbuddyStateStore } from "../../src/workbuddy/state.js";
import { setup, cipher } from "./fixture.js";

describe("WorkBuddy活动、切换和登录迁移", () => {
  it("官方活动从配置接口解析并持久化，失败保留缓存而非撤销折扣", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    const logged = await f.login(a.providerId);
    expect(logged.models?.find((m) => m.id === "model-new")).toMatchObject({
      promotions: [{ id: "e2e-free", discount: { factor: 0, discountedCredits: "0x" } }],
      tier: { id: "tier-test" },
    });
    expect(f.calls.find((c) => c.path === "/v3/config")?.headers.get("User-Agent")).toBe(
      "CLI/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0",
    );
    f.failMetadata();
    const status = await f.execute({ type: "sync-models", providerId: a.providerId });
    expect(status.models?.find((m) => m.id === "model-new")?.promotions?.[0]?.id).toBe("e2e-free");
    expect(status.modelDetailsError).toContain("活动查询失败");
  });

  it("登录导出导入往返仅迁移凭据，校验失败保留当前账号且status不含令牌", async () => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    const b = await f.execute({ type: "create" });
    await f.login(a.providerId);
    await f.login(b.providerId);
    await f.execute({ type: "set-model-fallback", providerId: b.providerId, enabled: true });
    const exported = await f.execute({ type: "export-login", providerId: a.providerId });
    expect(exported.loginExport).toContain("token-state-1");
    expect(exported.loginExport).not.toMatch(/secret|usage|pending|allowModelFallback/);
    const imported = await f.execute({
      type: "import-login",
      providerId: b.providerId,
      text: exported.loginExport!,
    });
    expect(imported.accountId).toBe("test-uid-1");
    expect(imported.allowModelFallback).toBe(true);
    expect(JSON.stringify(imported)).not.toMatch(/accessToken|refreshToken|loginExport/);
    for (const text of [
      "{",
      "{}",
      "x".repeat(65537),
      JSON.stringify({
        format: "zcode-workbuddy-login",
        version: 1,
        auth: { accessToken: "bad\nheader" },
      }),
    ]) {
      await expect(
        f.execute({ type: "import-login", providerId: b.providerId, text }),
      ).rejects.toThrow();
    }
    f.failProfile();
    await expect(
      f.execute({ type: "import-login", providerId: b.providerId, text: exported.loginExport! }),
    ).rejects.toThrow();
    const status = await f.execute({ type: "status", providerId: b.providerId });
    expect(status.accountId).toBe("test-uid-1");
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken|loginExport/);
    const stored = await new WorkbuddyStateStore(join(f.root, "accounts.enc"), cipher).read();
    expect(stored.accounts[a.providerId]!.secret).not.toBe(stored.accounts[b.providerId]!.secret);
  });

  it.each([
    "success",
    "sse",
    "json",
    "source-off",
    "target-off",
    "model-disabled",
    "target-disabled",
    "logged-out",
    "credits",
    "rate-limit",
    "all-exhausted",
  ])("6004同模型切换边界 %s", async (scenario) => {
    const f = await setup();
    const a = await f.execute({ type: "create" });
    const b = await f.execute({ type: "create" });
    expect(a.allowModelFallback).toBe(false);
    await f.login(a.providerId);
    await f.login(b.providerId);
    if (scenario !== "source-off")
      await f.execute({ type: "set-model-fallback", providerId: a.providerId, enabled: true });
    if (scenario !== "target-off")
      await f.execute({ type: "set-model-fallback", providerId: b.providerId, enabled: true });
    if (scenario === "model-disabled")
      await f.runtime.providerSettings.setPersonalModelEnabled(
        b.providerId,
        "deepseek-v4.1-flash",
        false,
      );
    if (scenario === "target-disabled")
      await f.runtime.providerSettings.savePersonalProviderOverlay(
        b.providerId,
        { integration: "workbuddy-cn" },
        { enabled: false },
      );
    if (scenario === "logged-out") await f.execute({ type: "logout", providerId: b.providerId });
    f.rejectChat(
      { code: scenario === "credits" ? 6010 : scenario === "rate-limit" ? 429 : 6004 },
      scenario === "all-exhausted" ? undefined : "Bearer token-state-1",
      scenario,
    );
    const provider = (await f.runtime.providerSettings.getView()).providers.find(
      (p) => p.providerId === a.providerId,
    )!;
    const access = provider.effectiveConfig.access!;
    if (access.type !== "api-key") throw new Error("invalid test access");
    const response = await fetch(`${provider.effectiveConfig.api!.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.apiKey}`,
        "Content-Type": "application/json",
        "X-Session-Id": "fallback-session",
      },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", input: "E2E_FALLBACK", stream: false }),
    });
    const output = await response.text();
    const calls = f.calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(calls).toHaveLength(
      ["success", "sse", "json", "all-exhausted"].includes(scenario) ? 2 : 1,
    );
    expect(calls.every((c) => c.body?.model === "deepseek-v4.1-flash")).toBe(true);
    expect(output).not.toContain("token-state");
    if (["success", "sse", "json"].includes(scenario)) {
      expect(response.status).toBe(200);
      expect(output).toContain("hello");
      expect(calls[1]!.authorization).toBe("Bearer token-state-2");
      const actual = await f.execute({
        type: "status",
        providerId: b.providerId,
        sessionId: "fallback-session",
      });
      expect(actual.usage?.credits).toBe(0.25);
      expect(
        (
          await f.execute({
            type: "status",
            providerId: a.providerId,
            sessionId: "fallback-session",
          })
        ).usage?.credits ?? 0,
      ).toBe(0);
    } else expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
