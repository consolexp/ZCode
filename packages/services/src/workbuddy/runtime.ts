import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { withFileLock } from "@zcode/shared/node";
import type { ProviderSettingsFacade } from "@zcode/provider";
import { z } from "zod";
import {
  WORKBUDDY_CN_MODELS,
  WORKBUDDY_CN_ID,
  type WorkbuddyAccountView,
  type WorkbuddyCommand,
  type WorkbuddyPort,
  type WorkbuddyCipher,
} from "./contract.js";
import { commandSchema, replaceLogin } from "./commands.js";
import { WorkbuddyStateStore, type WorkbuddyAccount } from "./state.js";
import {
  WorkbuddyUpstream,
  parseAuth,
  unwrapData,
  userId,
  type WorkbuddyAuth,
} from "./upstream.js";
import { createChatTransport, isModelDailyLimit } from "./transport.js";
import { authSchema } from "./upstream.js";
import type { UpstreamResponse } from "./vendor/wb-proxy.mjs";

export interface WorkbuddyRuntimeOptions {
  filePath: string;
  cipher: WorkbuddyCipher;
  settings: ProviderSettingsFacade;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class WorkbuddyRuntime implements WorkbuddyPort {
  readonly #store: WorkbuddyStateStore;
  readonly #upstream: WorkbuddyUpstream;
  readonly #now: () => number;
  #server?: Server;
  #timer?: ReturnType<typeof setInterval>;
  #ticking = false;
  #disposed = false;
  readonly #requests = new Set<AbortController>();

  constructor(private readonly options: WorkbuddyRuntimeOptions) {
    this.#store = new WorkbuddyStateStore(options.filePath, options.cipher);
    this.#upstream = new WorkbuddyUpstream(options.fetcher);
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.#ensureServer();
    // 旧接入默认走 Chat，空工具分片会让 SDK 反复结束思考；与已验证的 Responses 入口保持一致。
    for (const provider of this.options.settings.getView().providers) {
      const config = provider.personalConfig;
      if (config?.integration !== WORKBUDDY_CN_ID || config.api?.type !== "openai-chat-completions")
        continue;
      await this.options.settings.savePersonalProviderOverlay(provider.providerId, {
        ...config,
        api: { ...config.api, type: "openai-responses" },
      });
    }
    if (!this.#timer && !this.#disposed) {
      this.#timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, 30_000);
      this.#timer.unref();
      // 多账号或上游超时时，签到不能阻塞所有供应商的启动就绪。
      void this.tick().catch(() => {});
    }
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    for (const request of this.#requests) request.abort();
    this.#server?.close();
    this.#server?.closeAllConnections();
    this.#server = undefined;
  }

  async removeAccount(providerId: string): Promise<void> {
    await this.#store.update(async (state) => {
      delete state.accounts[providerId];
    });
  }

  async execute(input: WorkbuddyCommand): Promise<WorkbuddyAccountView> {
    if (this.#disposed) throw new Error("WorkBuddy 已关闭。");
    try {
      const command = commandSchema.parse(input);
      if (command.type === "create") return await this.#create(command.name);
      if (command.type === "export-login") {
        const state = await this.#store.read();
        const account = this.#account(command.providerId, state.accounts);
        return {
          ...this.#view(command.providerId, account),
          loginExport: JSON.stringify({
            format: "zcode-workbuddy-login",
            version: 1,
            auth: this.#requireAuth(account),
          }),
        };
      }
      if (command.type === "sync-models") {
        await this.#store.update(async (state) => {
          const account = this.#account(command.providerId, state.accounts);
          await this.#syncCatalog(account);
        });
        await this.#publishModels(command.providerId);
      } else if (command.type !== "status") {
        await this.#store.update(async (state) => {
          const account = this.#account(command.providerId, state.accounts);
          switch (command.type) {
            case "set-model-fallback":
              account.allowModelFallback = command.enabled;
              break;
            case "import-login": {
              const data = z
                .object({
                  format: z.literal("zcode-workbuddy-login"),
                  version: z.literal(1),
                  auth: authSchema,
                })
                .parse(JSON.parse(command.text));
              let auth = data.auth;
              if (auth.refreshToken && (auth.expiresAt ?? 0) <= this.#now() + 120_000)
                auth = await this.#upstream.refresh(auth);
              // 先验证再替换，坏凭据或网络失败不能清除当前登录。
              auth.account = await this.#upstream.profile(auth);
              replaceLogin(account, auth);
              await this.#syncCatalog(account);
              account.benefits = await this.#upstream.snapshot(auth);
              break;
            }
            case "login": {
              const response = await this.#upstream.api("/v2/plugin/auth/state?platform=CLI", {});
              const data = z
                .object({ state: z.string().min(1), authUrl: z.string().url() })
                .parse(unwrapData(response));
              if (new URL(data.authUrl).protocol !== "https:")
                throw new Error("WorkBuddy 登录地址无效。");
              account.pending = {
                id: randomUUID(),
                state: data.state,
                authUrl: data.authUrl,
                expiresAt: this.#now() + 600_000,
              };
              break;
            }
            case "cancel-login":
              delete account.pending;
              break;
            case "logout": {
              account.generation = randomUUID();
              delete account.claimUncertain;
              delete account.auth;
              delete account.pending;
              delete account.benefits;
              delete account.message;
              delete account.profileError;
              account.usage = {};
              delete account.autoAttemptDay;
              delete account.models;
              delete account.modelSource;
              delete account.modelSyncError;
              delete account.modelDetailsError;
              delete account.modelDetailsUpdatedAt;
              break;
            }
            case "poll": {
              const pending = account.pending;
              if (!pending || pending.id !== command.loginId || pending.expiresAt <= this.#now())
                throw new Error("WorkBuddy 登录已过期或取消，请重新登录。");
              const result = await this.#upstream.api(
                `/v2/plugin/auth/token?state=${encodeURIComponent(pending.state)}`,
              );
              const data = unwrapData(result);
              if (data && typeof data === "object" && "accessToken" in data) {
                replaceLogin(account, parseAuth(data, undefined, this.#now()));
                await this.#refreshProfile(account);
                await this.#syncCatalog(account);
                account.benefits = await this.#upstream.snapshot(this.#requireAuth(account));
              } else if (result.code && result.code !== 11217)
                throw new Error("WorkBuddy 授权未成功，请重新登录。");
              break;
            }
            case "refresh": {
              account.auth = await this.#upstream.refresh(this.#requireAuth(account));
              await this.#refreshProfile(account);
              account.benefits = await this.#upstream.snapshot(account.auth, account.benefits);
              if (!account.benefits.checkinError) delete account.claimUncertain;
              account.message = undefined;
              break;
            }
            case "checkin":
              await this.#checkin(account, () => this.#store.save(state));
              break;
          }
        });
        if (command.type === "poll" || command.type === "import-login")
          await this.#publishModels(command.providerId);
      }
      const state = await this.#store.read();
      const account = this.#account(command.providerId, state.accounts);
      return this.#view(
        command.providerId,
        account,
        "sessionId" in command ? command.sessionId : undefined,
      );
    } catch (error) {
      // 校验错误可能含令牌或上游内容，不能经过 RPC 错误日志输出原始异常。
      throw new Error(
        error instanceof Error && error.name === "Error" && error.message.startsWith("WorkBuddy ")
          ? error.message
          : "WorkBuddy 操作失败，请稍后重试或重新登录。",
      );
    }
  }

  async #create(name?: string): Promise<WorkbuddyAccountView> {
    await this.#ensureServer();
    const state = await this.#store.read();
    const secret = randomBytes(32).toString("hex");
    const result = await this.options.settings.createPersonalProvider({
      providerName: name?.trim() || "WorkBuddy 国内",
      initialConfig: {
        integration: WORKBUDDY_CN_ID,
        api: { type: "openai-responses", baseUrl: `http://127.0.0.1:${state.port}/v1` },
        access: { type: "api-key", apiKey: secret },
        logo: { type: "builtin", key: WORKBUDDY_CN_ID },
      },
    });
    try {
      await this.#store.update(async (current) => {
        current.accounts[result.providerId] = { secret, generation: randomUUID(), usage: {} };
      });
      await this.execute({ type: "sync-models", providerId: result.providerId });
      return this.execute({ type: "status", providerId: result.providerId });
    } catch (error) {
      await this.options.settings.deletePersonalProvider(result.providerId);
      await this.#store.update(async (current) => {
        delete current.accounts[result.providerId];
      });
      throw error;
    }
  }

  #account(providerId: string, accounts: Record<string, WorkbuddyAccount>): WorkbuddyAccount {
    const provider = this.options.settings
      .getView()
      .providers.find(
        (p) => p.providerId === providerId && p.effectiveConfig.integration === WORKBUDDY_CN_ID,
      );
    const account = accounts[providerId];
    if (!provider || !account) throw new Error("WorkBuddy 渠道已删除或账号数据不存在。");
    return account;
  }

  #requireAuth(account: WorkbuddyAccount): WorkbuddyAuth {
    if (!account.auth) throw new Error("WorkBuddy 尚未登录，请先授权账号。");
    return account.auth;
  }

  async #freshAuth(account: WorkbuddyAccount): Promise<WorkbuddyAuth> {
    const auth = this.#requireAuth(account);
    if (auth.refreshToken && (auth.expiresAt ?? 0) <= this.#now() + 120_000)
      account.auth = await this.#upstream.refresh(auth);
    return this.#requireAuth(account);
  }

  async #syncCatalog(account: WorkbuddyAccount): Promise<void> {
    if (account.auth) {
      try {
        const previous = account.models;
        account.models = await this.#upstream.models(await this.#freshAuth(account));
        for (const model of account.models) {
          const old = previous?.find((item) => item.id === model.id);
          model.promotions = old?.promotions;
          model.tier = old?.tier;
          model.userType = account.auth?.account?.userType;
        }
        await this.#refreshModelDetails(account);
        account.modelSource = "account";
        delete account.modelSyncError;
        return;
      } catch {
        account.modelSyncError = "在线模型目录同步失败，保留已有目录；可稍后重试。";
      }
    }
    if (!account.models) {
      account.models = WORKBUDDY_CN_MODELS.map((id) => ({ id, name: id }));
      account.modelSource = "snapshot";
    }
  }

  async #refreshModelDetails(account: WorkbuddyAccount): Promise<void> {
    const errors: string[] = [];
    try {
      const metadata = await this.#upstream.productMetadata(this.#requireAuth(account));
      for (const model of account.models ?? []) {
        model.promotions = metadata.modelPromotions.filter((item) =>
          item.modelIds?.includes(model.id),
        );
        model.tier = metadata.modelTiers
          .filter((item) => item.enabled !== false && item.modelIds?.includes(model.id))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      }
    } catch {
      errors.push("官方活动查询失败，保留已有活动；请重新打开菜单刷新。");
    }
    try {
      const levels = await this.#upstream.busyLevels(
        this.#requireAuth(account),
        (account.models ?? []).map((model) => model.id),
      );
      for (const model of account.models ?? []) model.busyLevel = levels.get(model.id) ?? "unknown";
      account.modelDetailsUpdatedAt = this.#now();
      delete account.modelDetailsError;
    } catch {
      // 忙闲查询失败不能伪装空闲，也不能让可用模型目录回退为静态快照。
      for (const model of account.models ?? []) model.busyLevel = "unknown";
      delete account.modelDetailsUpdatedAt;
      errors.push("模型忙闲查询失败，请稍后重新打开模型菜单。");
    }
    account.modelDetailsError = errors.join(" ") || undefined;
  }

  async #refreshProfile(account: WorkbuddyAccount): Promise<void> {
    try {
      const auth = this.#requireAuth(account);
      auth.account = await this.#upstream.profile(auth);
      delete account.profileError;
    } catch {
      account.profileError = "WorkBuddy 账号资料读取失败，保留已知资料；请手动刷新重试。";
    }
  }

  async #publishModels(providerId: string): Promise<void> {
    const state = await this.#store.read();
    const account = this.#account(providerId, state.accounts);
    for (const model of account.models ?? []) {
      const values = model.reasoning?.supportedEfforts.length
        ? model.reasoning.supportedEfforts
        : [model.reasoning?.defaultEffort ?? "default"];
      const reasoningLevel = {
        values,
        map: model.reasoning ? '{ "reasoning": { "effort": reasoningLevel } }' : "{}",
      };
      const provider = this.options.settings
        .getView()
        .providers.find((p) => p.providerId === providerId);
      if (!provider) throw new Error("WorkBuddy 渠道已删除。");
      if (!provider.models.some((m) => m.modelId === model.id))
        await this.options.settings.addPersonalModel(
          providerId,
          model.id,
          {
            enabled: !model.disabled,
            properties: {
              contextWindow: model.contextWindow,
              inputFormat: { supportsImage: model.supportsImages },
            },
            optionSpecs: { reasoningLevel },
          },
          true,
        );
      else {
        const current = provider.models.find((m) => m.modelId === model.id)!;
        if (
          JSON.stringify(current.personalExactConfig?.optionSpecs?.reasoningLevel) ===
          JSON.stringify(reasoningLevel)
        )
          continue;
        await this.options.settings.savePersonalModelDraft({
          providerId,
          originalModelId: model.id,
          nextModelId: model.id,
          personalConfig: {
            ...current.personalExactConfig,
            optionSpecs: { ...current.personalExactConfig?.optionSpecs, reasoningLevel },
          },
          basedOnRevision: this.options.settings.getView().revision,
          useRecommendedConfig: current.useRecommendedConfig,
        });
      }
    }
  }

  async #checkin(account: WorkbuddyAccount, persist: () => Promise<void>): Promise<void> {
    const auth = await this.#freshAuth(account);
    const before = await this.#upstream.checkinStatus(auth);
    if (before.todayCheckedIn || !before.active)
      account.message = before.todayCheckedIn ? "今日已签到。" : "当前签到活动未开放。";
    else if (account.claimUncertain)
      account.message = "上次领取结果未确认，请先刷新账号与签到状态后再操作。";
    else {
      account.claimUncertain = true;
      await persist();
      try {
        await this.#upstream.billing("daily-checkin", auth);
        delete account.claimUncertain;
        account.message = "签到成功。";
      } catch {
        account.message = "未能确认签到结果，已查询状态，请确认后再操作。";
      }
    }
    account.benefits = await this.#upstream.snapshot(auth, account.benefits);
    if (!account.benefits.checkinError && account.benefits.checkin?.todayCheckedIn)
      delete account.claimUncertain;
  }

  #view(providerId: string, account: WorkbuddyAccount, sessionId?: string): WorkbuddyAccountView {
    return {
      providerId,
      connected: !!account.auth,
      allowModelFallback: account.allowModelFallback ?? false,
      accountName: account.auth?.account?.name ?? account.auth?.name,
      accountId: account.auth ? userId(account.auth) : undefined,
      profileError: account.profileError,
      expiresAt: account.auth?.expiresAt,
      pendingLogin:
        account.pending && account.pending.expiresAt > this.#now()
          ? {
              id: account.pending.id,
              authUrl: account.pending.authUrl,
              expiresAt: account.pending.expiresAt,
            }
          : undefined,
      benefits: account.benefits,
      message: account.message,
      models: account.models,
      modelSource: account.modelSource,
      modelSyncError: account.modelSyncError,
      modelDetailsUpdatedAt: account.modelDetailsUpdatedAt,
      modelDetailsError: account.modelDetailsError,
      usage: Object.hasOwn(account.usage, sessionKey(sessionId))
        ? account.usage[sessionKey(sessionId)]
        : undefined,
    };
  }

  /** 每窗口可唤醒；共享文件锁与当日标记保证自动领取不会因多窗口重复。 */
  async tick(): Promise<void> {
    if (this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      await this.#ensureServer();
      const providers = this.options.settings.getView().providers;
      const state = await this.#store.read();
      for (const id of Object.keys(state.accounts)) {
        if (this.#disposed) return;
        const provider = providers.find(
          (p) => p.providerId === id && p.effectiveConfig.integration === WORKBUDDY_CN_ID,
        );
        if (!provider) {
          continue;
        }
        if (!provider.enabled) continue;
        await this.#store.update(async (s) => {
          const account = this.#account(id, s.accounts);
          if (!account.auth || this.#disposed) return;
          const day = new Date(this.#now() + 8 * 3600_000).toISOString().slice(0, 10);
          try {
            if (account.autoAttemptDay !== day) {
              account.autoAttemptDay = day;
              // 在领取前落盘；进程崩溃或响应丢失后不能重复自动领取。
              await this.#store.save(s);
              await this.#checkin(account, () => this.#store.save(s));
            }
          } catch {
            account.message = "WorkBuddy 后台刷新或签到失败，请手动刷新账号。";
          }
        });
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #ensureServer(): Promise<void> {
    if (this.#disposed || this.#server) return;
    await withFileLock(`${this.#store.path}.endpoint`, async () => {
      if (this.#disposed || this.#server) return;
      const state = await this.#store.read();
      const server = createServer((req, res) => {
        void this.#handle(req, res).catch(() => {
          if (res.headersSent) res.destroy();
          else {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: "WorkBuddy 请求失败，请检查登录状态或稍后重试。" },
              }),
            );
          }
        });
      });
      server.requestTimeout = 300_000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(state.port, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
      } catch (error) {
        server.close();
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && state.port) return;
        throw error;
      }
      if (this.#disposed) {
        server.close();
        return;
      }
      this.#server = server;
      server.unref();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("WorkBuddy 本机转接启动失败。");
      await this.#store.update(async (s) => {
        s.port = address.port;
      });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const responses = req.url === "/v1/responses" || req.url === "/responses";
    if (
      req.headers.origin ||
      req.method !== "POST" ||
      (!responses && req.url !== "/v1/chat/completions" && req.url !== "/chat/completions")
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const state = await this.#store.read();
    const key = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const entry = Object.entries(state.accounts).find(([, account]) => {
      const secret = Buffer.from(account.secret),
        candidate = Buffer.from(key);
      return candidate.length === secret.length && timingSafeEqual(candidate, secret);
    });
    if (!entry) {
      res.writeHead(401);
      res.end();
      return;
    }
    const providerId = entry[0];
    const generation = entry[1].generation;
    const provider = this.options.settings
      .getView()
      .providers.find((p) => p.providerId === providerId);
    if (!provider?.enabled) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    let actualProviderId = providerId;
    let actualGeneration = generation;
    let body: ReturnType<ReturnType<typeof createChatTransport>["request"]>;
    const transport = createChatTransport({
      fetcher: this.options.fetcher ?? fetch,
      signal,
      withAuthRetry: async (send) => {
        const tried = new Set<string>();
        for (;;) {
          tried.add(actualProviderId);
          let up = await this.#sendAuthenticated(
            actualProviderId,
            actualGeneration,
            body.model,
            send,
            { providerId, generation },
          );
          if (up.ok) return { up };
          const text = await up.text();
          // 官方只将 6004 解释为模型用量上限；积分不足和通用429不得消耗另一账号额度。
          let exhausted = false;
          try {
            exhausted = isModelDailyLimit(JSON.parse(text));
          } catch {
            /* 非结构化响应不能推断为单模型额度耗尽。 */
          }
          up = {
            ...up,
            stream: Object.assign(Readable.from([Buffer.from(text)]), { statusCode: up.status }),
            text: async () => text,
          };
          if (!exhausted || signal.aborted) return { up };
          const current = await this.#store.read();
          const source = this.#account(providerId, current.accounts);
          if (
            source.generation !== generation ||
            !source.allowModelFallback ||
            !this.options.settings.getView().providers.find((p) => p.providerId === providerId)
              ?.enabled
          )
            return { up };
          const candidates = this.options.settings.getView().providers;
          const next = candidates.find((candidate) => {
            const account = current.accounts[candidate.providerId];
            return (
              !tried.has(candidate.providerId) &&
              candidate.effectiveConfig.integration === WORKBUDDY_CN_ID &&
              candidate.enabled &&
              account?.auth &&
              account.allowModelFallback &&
              candidate.models.some((model) => model.modelId === body.model && model.enabled) &&
              account.models?.some((model) => model.id === body.model && !model.disabled)
            );
          });
          if (!next) return { up };
          actualProviderId = next.providerId;
          actualGeneration = current.accounts[actualProviderId]!.generation;
          await this.#store.update(async (s) => {
            const account = this.#account(providerId, s.accounts);
            if (account.generation === generation)
              account.message = `模型当日用量已达上限，本次尝试同款模型渠道：${next.providerName || "WorkBuddy"}。`;
          });
        }
      },
    });
    try {
      body = transport.request(JSON.parse(Buffer.concat(chunks).toString("utf8")), responses);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "WorkBuddy 请求格式无效或包含不支持的输入。",
            code: "unsupported_input",
          },
        }),
      );
      return;
    }
    if (
      !provider.models.some((m) => m.modelId === body.model && m.enabled) ||
      entry[1].models?.find((m) => m.id === body.model)?.disabled
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: "模型未启用。" } }));
      return;
    }
    const reasoning = entry[1].models?.find((model) => model.id === body.model)?.reasoning;
    if (reasoning) {
      // 旧会话可能携带通用档位；仅使用该模型声明的档位，固定模型遵循上游默认值。
      const requested =
        typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
      const selected =
        requested && reasoning.supportedEfforts.includes(requested)
          ? requested
          : reasoning.defaultEffort;
      if (selected) body.reasoning_effort = selected;
      else delete body.reasoning_effort;
    } else delete body.reasoning_effort;
    this.#requests.add(controller);
    const abort = () => controller.abort();
    res.once("close", abort);
    const sessionHeader = req.headers["x-session-id"];
    const sessionId =
      typeof sessionHeader === "string" && sessionHeader.length <= 200 ? sessionHeader : undefined;
    let reported: number | undefined;
    let previous = 0;
    try {
      await transport.relay(body, res, responses, async (credit) => {
        reported = credit;
        await this.#recordUsage(
          actualProviderId,
          actualGeneration,
          sessionId,
          credit - previous,
          false,
          false,
        );
        previous = credit;
      });
    } finally {
      res.removeListener("close", abort);
      controller.abort();
      this.#requests.delete(controller);
      await this.#recordUsage(
        actualProviderId,
        actualGeneration,
        sessionId,
        0,
        reported !== undefined,
        reported === undefined,
      );
    }
  }

  async #sendAuthenticated(
    providerId: string,
    generation: string,
    model: string,
    send: (auth: WorkbuddyAuth) => Promise<UpstreamResponse>,
    source: { providerId: string; generation: string },
  ): Promise<UpstreamResponse> {
    let auth = await this.#store.update(async (state) => {
      const account = this.#account(providerId, state.accounts);
      const origin = this.#account(source.providerId, state.accounts);
      const sourceEnabled = this.options.settings
        .getView()
        .providers.find((p) => p.providerId === source.providerId)?.enabled;
      if (
        origin.generation !== source.generation ||
        !sourceEnabled ||
        (source.providerId !== providerId &&
          (!origin.allowModelFallback || !account.allowModelFallback))
      )
        throw new Error("WorkBuddy 渠道切换设置已变更，请重试。");
      const provider = this.options.settings
        .getView()
        .providers.find((p) => p.providerId === providerId);
      if (
        account.generation !== generation ||
        !provider?.enabled ||
        !provider.models.some((m) => m.modelId === model && m.enabled) ||
        account.models?.find((m) => m.id === model)?.disabled
      )
        throw new Error("WorkBuddy 账号或模型已变更，请重试。");
      return this.#freshAuth(account);
    });
    let up = await send(auth);
    if (up.status === 401 && auth.refreshToken) {
      up.stream.destroy();
      auth = await this.#store.update(async (state) => {
        const account = this.#account(providerId, state.accounts);
        if (account.generation !== generation) throw new Error("WorkBuddy 账号已切换，请重试。");
        // 其它请求若已刷新，复用新令牌，避免旧刷新令牌并发旋转。
        if (account.auth?.accessToken === auth.accessToken)
          account.auth = await this.#upstream.refresh(auth);
        return this.#requireAuth(account);
      });
      up = await send(auth);
    }
    return up;
  }

  async #recordUsage(
    providerId: string,
    generation: string,
    sessionId: string | undefined,
    delta: number,
    reported: boolean,
    unreported: boolean,
  ): Promise<void> {
    await this.#store.update(async (state) => {
      const account = state.accounts[providerId];
      if (!account?.auth || account.generation !== generation) return;
      for (const id of new Set(["all", sessionKey(sessionId)])) {
        const usage = Object.hasOwn(account.usage, id)
          ? account.usage[id]!
          : {
              credits: 0,
              reportedRequests: 0,
              unreportedRequests: 0,
              updatedAt: 0,
            };
        usage.credits = Math.max(0, Math.round((usage.credits + delta) * 1e6) / 1e6);
        usage.reportedRequests += Number(reported);
        usage.unreportedRequests += Number(unreported);
        usage.updatedAt = this.#now();
        account.usage[id] = usage;
      }
      const oldIds = Object.keys(account.usage)
        .filter((id) => id !== "all")
        .sort((a, b) => account.usage[b]!.updatedAt - account.usage[a]!.updatedAt)
        .slice(200);
      for (const id of oldIds) delete account.usage[id];
    });
  }
}

function sessionKey(sessionId?: string): string {
  // CLI 归因头剥离内部前缀；Renderer 查询使用原始 sessionId，必须落到同一个统计 key。
  let value = sessionId || "all";
  for (const prefix of ["sess_", "subagent_agent_"])
    if (value.startsWith(prefix) && value.length > prefix.length)
      value = value.slice(prefix.length);
  return ["__proto__", "constructor", "prototype"].includes(value) ? `session:${value}` : value;
}
