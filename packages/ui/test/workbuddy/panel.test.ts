// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  WorkbuddyPanel,
  WorkbuddyCredits,
  WorkbuddyModelInfo,
  WorkbuddyModelSummary,
} from "@/workbuddy/index.js";
import { workbuddyMessagesZhCN } from "@/workbuddy/messages.js";

const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  open: vi.fn(),
  service: {} as Record<string, unknown>,
}));
const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) => {
    let text: string = (workbuddyMessagesZhCN as Record<string, string>)[id] ?? id;
    for (const [key, value] of Object.entries(values ?? {}))
      text = text.replace(`{${key}}`, String(value));
    return text;
  },
};
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ intl, locale: "zh-CN" }) }));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openExternal: mock.open }) }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: mock.service }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function provider(id = "wb-one"): ProviderSettingsFormProvider {
  return {
    providerId: id,
    providerName: "WorkBuddy 国内",
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: { integration: "workbuddy-cn" },
    config: { integration: "workbuddy-cn" },
    models: [
      {
        kind: "candidate",
        modelId: "hy3",
        builtin: false,
        personalConfig: {},
        config: { enabled: true },
        hasPersonalConfig: true,
        executable: true,
        selectable: true,
      },
    ],
  };
}

describe("WorkBuddy 模型倍率摘要", () => {
  it("省略普通倍率及折扣原价中的 credits，保留倍率数值和划线", () => {
    const { rerender, container } = render(
      createElement(WorkbuddyModelSummary, {
        model: { id: "deepseek", name: "DeepSeek-V4.1-Flash", credits: "x0.11 credits" },
      }),
    );
    expect(container.textContent).toBe("x0.11");
    rerender(
      createElement(WorkbuddyModelSummary, {
        model: {
          id: "deepseek",
          name: "DeepSeek-V4.1-Flash",
          credits: "1.00x credits",
          promotions: [
            { id: "discount", kind: "discount", discount: { discountedCredits: "0.11x credits" } },
          ],
        },
      }),
    );
    expect(container.textContent).not.toContain("credits");
    expect(container.querySelector("del")?.textContent).toBe("1.00x");
    expect(screen.getByText("0.11x")).toBeTruthy();
  });
});

describe("WorkBuddy 设置面板", () => {
  it("独立保存切换开关，显式复制登录信息，粘贴验证成功清空输入且凭据不显示", async () => {
    mock.service.workbuddy = mock.execute;
    const login = JSON.stringify({
      format: "zcode-workbuddy-login",
      version: 1,
      auth: { accessToken: "E2E_PRIVATE_LOGIN" },
    });
    let enabled = false;
    mock.execute.mockImplementation(async (command) => {
      if (command.type === "set-model-fallback") enabled = command.enabled;
      return {
        providerId: "wb-one",
        connected: true,
        allowModelFallback: enabled,
        ...(command.type === "export-login" ? { loginExport: login } : {}),
      };
    });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    render(
      createElement(WorkbuddyPanel, { provider: provider(), onSave: vi.fn(), onDelete: vi.fn() }),
    );
    await screen.findByText("已登录");
    expect(screen.getByTestId("workbuddy-model-fallback").getAttribute("aria-checked")).toBe(
      "false",
    );
    fireEvent.click(screen.getByTestId("workbuddy-model-fallback"));
    await waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith({
        type: "set-model-fallback",
        providerId: "wb-one",
        enabled: true,
      }),
    );
    fireEvent.click(screen.getByTestId("workbuddy-export-login"));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(login));
    expect(screen.queryByText(/E2E_PRIVATE_LOGIN/)).toBeNull();
    fireEvent.click(screen.getByTestId("workbuddy-import-login"));
    fireEvent.change(screen.getByTestId("workbuddy-login-text"), { target: { value: login } });
    fireEvent.click(screen.getByRole("button", { name: "验证并导入" }));
    await screen.findByText("登录信息已导入。");
    expect(mock.execute).toHaveBeenCalledWith({
      type: "import-login",
      providerId: "wb-one",
      text: login,
    });
    expect(screen.queryByTestId("workbuddy-login-text")).toBeNull();
  });

  it("模型详情支持点击与键盘，保留零倍数、窗口和固定思考信息，不触发模型选择", async () => {
    const select = vi.fn();
    render(
      createElement(
        "div",
        { onClick: select },
        createElement(WorkbuddyModelInfo, {
          model: {
            id: "hy4",
            name: "Hy4 preview",
            descriptionZh: "测试增强推理说明",
            credits: "x0.00",
            badges: ["夜间免费"],
            contextWindow: 300000,
            contextWindows: [300000, 960000],
            busyLevel: "idle",
            reasoning: { defaultEffort: "high", supportedEfforts: ["high"] },
          },
        }),
      ),
    );
    const trigger = screen.getByRole("button", { name: "Hy4 preview 模型详情" });
    fireEvent.click(trigger);
    const details = await screen.findByTestId("workbuddy-model-details-hy4");
    expect(details.textContent).toContain("测试增强推理说明");
    expect(details.textContent).toContain("x0.00");
    expect(details.textContent).toContain("夜间免费");
    expect(details.textContent).toContain("空闲");
    expect(details.textContent).toContain("30万 / 96万");
    expect(details.textContent).toContain("高 · 固定");
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("workbuddy-model-details-hy4")).toBeNull());
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByTestId("workbuddy-model-details-hy4")).toBeTruthy();
  });

  it("缺失的倍率、忙闲和思考能力不伪装为零、空闲或高强度", async () => {
    render(createElement(WorkbuddyModelInfo, { model: { id: "unknown", name: "Unknown" } }));
    fireEvent.click(screen.getByRole("button"));
    const details = await screen.findByTestId("workbuddy-model-details-unknown");
    expect(details.textContent).toContain("未知");
    expect(details.textContent).toContain("未提供");
    expect(details.textContent).not.toContain("空闲");
    expect(details.textContent).not.toContain("固定");
  });
  it("展示余额、签到和在线倍数，名称与启停通过正式补丁保存", async () => {
    mock.service.workbuddy = mock.execute;
    mock.execute.mockResolvedValue({
      providerId: "wb-one",
      connected: true,
      accountName: "E2E nickname",
      accountId: "E2E-account-123",
      modelSource: "account",
      models: [{ id: "hy3", name: "Hunyuan", credits: "x0.8" }],
      benefits: {
        credits: { remaining: 123, packages: [] },
        creditsError: "",
        checkinError: "",
        checkedAt: Date.now(),
        checkin: {
          active: true,
          todayCheckedIn: false,
          streakDays: 2,
          totalCredits: 15,
          dates: [],
        },
      },
    });
    const onSave = vi.fn(async () => {}),
      onSet = vi.fn(async () => {});
    render(
      createElement(WorkbuddyPanel, {
        provider: provider(),
        onSave,
        onDelete: vi.fn(),
        onSetPersonalModelEnabled: onSet,
      }),
    );
    await screen.findByText("123");
    expect(screen.getByTestId("workbuddy-account-status").textContent).toContain("E2E nickname");
    expect(screen.getByTestId("workbuddy-account-id").textContent).toContain("E2E-account-123");
    expect(screen.getByText("x0.8")).toBeTruthy();
    fireEvent.change(screen.getByTestId("workbuddy-name"), { target: { value: "账号二" } });
    fireEvent.click(screen.getByText("保存名称"));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ providerNameUpdate: "账号二" }),
      ),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith("wb-one", "hy3", false));
  });

  it("登录打开返回的授权页，切换渠道不会显示旧渠道的迟到结果", async () => {
    mock.service.workbuddy = mock.execute;
    let resolveOld!: (value: unknown) => void;
    mock.execute.mockImplementation((command) => {
      if (command.providerId === "wb-one")
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return Promise.resolve({
        providerId: "wb-two",
        connected: false,
        ...(command.type === "login"
          ? {
              pendingLogin: {
                id: "login-two",
                authUrl: "https://www.workbuddy.cn/login/example",
                expiresAt: Date.now() + 600000,
              },
            }
          : {}),
      });
    });
    const props = { onSave: vi.fn(), onDelete: vi.fn() };
    const view = render(
      createElement(WorkbuddyPanel, { key: "one", provider: provider(), ...props }),
    );
    view.rerender(
      createElement(WorkbuddyPanel, { key: "two", provider: provider("wb-two"), ...props }),
    );
    await screen.findByText("尚未登录");
    resolveOld({ providerId: "wb-one", connected: true, accountName: "OLD ACCOUNT" });
    fireEvent.click(screen.getByTestId("workbuddy-login"));
    await waitFor(() =>
      expect(mock.open).toHaveBeenCalledWith("https://www.workbuddy.cn/login/example"),
    );
    expect(screen.queryByText(/OLD ACCOUNT/)).toBeNull();
  });

  it("会话积分读取本地 status，缺失上报明确标记，不查询余额", async () => {
    mock.service.workbuddy = mock.execute;
    mock.execute.mockResolvedValue({
      providerId: "wb-one",
      connected: true,
      usage: { credits: 0.75, reportedRequests: 2, unreportedRequests: 1, updatedAt: Date.now() },
    });
    render(createElement(WorkbuddyCredits, { providerId: "wb-one", sessionId: "sess_example" }));
    await screen.findByText(/本会话 0.75 积分/);
    expect(mock.execute).toHaveBeenCalledWith({
      type: "status",
      providerId: "wb-one",
      sessionId: "sess_example",
    });
    expect(screen.getByTestId("workbuddy-session-credits").title).toContain("未返回积分");
    expect(mock.execute.mock.calls.every(([command]) => command.type === "status")).toBe(true);
  });
});
