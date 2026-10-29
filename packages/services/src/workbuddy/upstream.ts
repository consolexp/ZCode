// 协议参考 apiredirect 与 wb-proxy（MIT，见 THIRD_PARTY_NOTICES.md）。
import { z } from "zod";
import type { WorkbuddyBenefits, WorkbuddyModel } from "./contract.js";
import { productMetadataSchema } from "./metadata.js";

export const WORKBUDDY_ORIGIN = "https://www.workbuddy.cn";
const tokenText = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[^\r\n]+$/);
export const authSchema = z.object({
  accessToken: tokenText,
  refreshToken: tokenText.optional(),
  expiresAt: z.number().finite().optional(),
  uid: z.union([z.string(), z.number()]).optional(),
  name: z.string().max(200).optional(),
  account: z
    .object({
      uid: z.union([z.string(), z.number()]).optional(),
      name: z.string().max(200).optional(),
      userType: z.string().max(50).optional(),
    })
    .optional(),
});
export type WorkbuddyAuth = z.infer<typeof authSchema>;
type JsonObject = Record<string, unknown>;
const effort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);

export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("WorkBuddy 返回了空响应。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("WorkBuddy 响应过大。");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function parseAuth(
  value: unknown,
  previous?: WorkbuddyAuth,
  now = Date.now(),
): WorkbuddyAuth {
  const token = z
    .object({ expiresIn: z.number().positive().finite().optional() })
    .passthrough()
    .parse(value);
  return authSchema.parse({
    ...previous,
    ...token,
    ...(token.expiresIn ? { expiresAt: now + token.expiresIn * 1000 } : {}),
  });
}

export function userId(auth: WorkbuddyAuth): string | undefined {
  const uid = auth.account?.uid ?? auth.uid;
  if (uid !== undefined) return String(uid);
  try {
    return z
      .object({ sub: z.string() })
      .parse(JSON.parse(Buffer.from(auth.accessToken.split(".")[1] ?? "", "base64url").toString()))
      .sub;
  } catch {
    return undefined;
  }
}

export class WorkbuddyUpstream {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async api(
    path: string,
    body?: JsonObject,
    auth?: WorkbuddyAuth,
    refresh = false,
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Domain": "www.workbuddy.cn",
    };
    if (path === "/v3/config") {
      // 官方 asar 的 CLI 平台 UA 决定活动配置版本，普通 fetch UA 会被拒绝或返回旧配置。
      headers["User-Agent"] = "CLI/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
      headers["X-Product"] = "SaaS";
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    if (auth) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
      const uid = userId(auth);
      if (uid) headers["X-User-Id"] = encodeURIComponent(uid);
      if (refresh && auth.refreshToken) headers["X-Refresh-Token"] = auth.refreshToken;
    }
    const response = await this.fetcher(`${WORKBUDDY_ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "WorkBuddy 登录已失效，请重新登录。"
          : `WorkBuddy 请求失败（HTTP ${response.status}）。`,
      );
    }
    return z.record(z.string(), z.unknown()).parse(await readJson(response));
  }

  async refresh(auth: WorkbuddyAuth): Promise<WorkbuddyAuth> {
    if (!auth.refreshToken) throw new Error("账号缺少刷新令牌，请重新登录。");
    const result = await this.api("/v2/plugin/auth/token/refresh", {}, auth, true);
    if (result.code !== undefined && result.code !== 0)
      throw new Error("WorkBuddy 拒绝刷新账号，请重新登录。");
    return parseAuth(unwrapData(result), auth);
  }

  async profile(auth: WorkbuddyAuth): Promise<NonNullable<WorkbuddyAuth["account"]>> {
    const response = await this.api("/v2/accounts", undefined, auth);
    if (response.code !== undefined && response.code !== 0)
      throw new Error("WorkBuddy 账号资料查询失败。");
    const data = z
      .object({
        accounts: z
          .array(
            z.object({
              uid: z.union([z.string().min(1).max(200), z.number().finite()]),
              type: z.string(),
              nickname: z.string().max(200).nullish(),
              user_type: z.string().max(50).optional(),
            }),
          )
          .max(100),
      })
      .parse(unwrapData(response));
    const account = data.accounts.find((item) => item.type === "personal");
    if (!account) throw new Error("WorkBuddy 未返回个人账号资料。");
    return {
      uid: account.uid,
      name: account.nickname?.trim() || undefined,
      userType: account.user_type,
    };
  }

  async productMetadata(auth: WorkbuddyAuth) {
    const result = await this.api("/v3/config", undefined, auth);
    if (result.code !== undefined && result.code !== 0) throw new Error("WorkBuddy 活动查询失败。");
    return productMetadataSchema.parse(unwrapData(result));
  }

  async models(auth: WorkbuddyAuth): Promise<WorkbuddyModel[]> {
    // 官方 ModelsService 使用同一配置接口，并按 cli agent 过滤可见模型。
    const response = await this.api("/v2/enterprises/personal/models", undefined, auth);
    if (response.code !== undefined && response.code !== 0)
      throw new Error("WorkBuddy 模型目录查询失败。");
    const payload = z
      .object({
        models: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              name: z.string().max(200).optional(),
              credits: z.union([z.string().max(100), z.number().finite()]).nullish(),
              // 国内目录实际包含窗口选项对象；只按数字校验会拒绝整份在线目录。
              contextWindow: z
                .union([
                  z.number().int().positive(),
                  z.object({
                    defaultLength: z.number().int().positive(),
                    supportedLengths: z.array(z.number().int().positive()).optional(),
                  }),
                ])
                .nullish(),
              maxInputTokens: z.number().int().positive().nullish(),
              maxOutputTokens: z.number().int().positive().nullish(),
              description: z.string().max(4000).nullish(),
              descriptionZh: z.string().max(4000).nullish(),
              descriptionEn: z.string().max(4000).nullish(),
              supportsImages: z.boolean().nullish(),
              disabledMultimodal: z.boolean().nullish(),
              supportsReasoning: z.boolean().nullish(),
              reasoning: z
                .object({
                  effort: z.string().max(30).optional(),
                  defaultEffort: z.string().max(30).optional(),
                  supportedEfforts: z.array(z.string().max(30)).max(20).optional(),
                  canDisableThinking: z.boolean().optional(),
                })
                .nullish(),
              disabled: z.boolean().nullish(),
              disabledReason: z.string().max(1000).nullish(),
              tags: z.array(z.string().max(500)).max(100).optional(),
            }),
          )
          .max(1000),
        agents: z
          .array(z.object({ name: z.string(), models: z.array(z.string()).optional() }))
          .optional(),
      })
      .parse(response.data ?? response);
    const cliModels = payload.agents?.find((agent) => agent.name === "cli")?.models;
    const models = payload.models
      .filter(
        (model) =>
          (!cliModels?.length || cliModels.includes(model.id)) &&
          !model.tags?.includes("text-to-image"),
      )
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        credits: model.credits == null ? undefined : String(model.credits),
        description: model.description ?? undefined,
        descriptionZh: model.descriptionZh ?? undefined,
        descriptionEn: model.descriptionEn ?? undefined,
        badges: (model.tags ?? []).flatMap((tag) =>
          tag.startsWith("badge:") ? [tag.split(":")[1]!.slice(0, 200)] : [],
        ),
        contextWindow:
          typeof model.contextWindow === "object" && model.contextWindow
            ? model.contextWindow.defaultLength
            : (model.contextWindow ?? model.maxInputTokens ?? undefined),
        contextWindows:
          typeof model.contextWindow === "object" && model.contextWindow
            ? [
                ...new Set([
                  model.contextWindow.defaultLength,
                  ...(model.contextWindow.supportedLengths ?? []),
                ]),
              ]
            : undefined,
        maxInputTokens: model.maxInputTokens ?? undefined,
        maxOutputTokens: model.maxOutputTokens ?? undefined,
        supportsImages: model.disabledMultimodal ? false : (model.supportsImages ?? undefined),
        supportsReasoning: model.supportsReasoning ?? undefined,
        reasoning: model.reasoning
          ? {
              defaultEffort: model.reasoning.defaultEffort ?? model.reasoning.effort,
              supportedEfforts: [
                ...new Set(
                  (model.reasoning.supportedEfforts ?? []).filter(
                    (value) => effort.safeParse(value).success,
                  ),
                ),
              ],
              canDisableThinking: model.reasoning.canDisableThinking,
            }
          : undefined,
        disabled: model.disabled ?? undefined,
        disabledReason: model.disabledReason ?? undefined,
      }));
    if (!models.length) throw new Error("WorkBuddy 返回了空模型目录。");
    return [...new Map(models.map((model) => [model.id, model])).values()];
  }

  async busyLevels(
    auth: WorkbuddyAuth,
    models: readonly string[],
  ): Promise<Map<string, NonNullable<WorkbuddyModel["busyLevel"]>>> {
    const levels = new Map<string, NonNullable<WorkbuddyModel["busyLevel"]>>();
    for (let offset = 0; offset < models.length; offset += 50) {
      const ids = models.slice(offset, offset + 50);
      const response = z
        .object({
          code: z.literal(0),
          data: z
            .array(
              z.object({
                model: z.string().max(200),
                busy_level: z.string().max(30),
              }),
            )
            .max(1000),
        })
        .parse(await this.api("/v2/chat/busy", { models: ids }, auth));
      for (const item of response.data) {
        if (!ids.includes(item.model)) continue;
        const level = z
          .enum(["idle", "normal", "busy", "congested", "unavailable"])
          .safeParse(item.busy_level);
        levels.set(item.model, level.success ? level.data : "unknown");
      }
    }
    return levels;
  }

  async billing(action: string, auth: WorkbuddyAuth, body: JsonObject = {}): Promise<JsonObject> {
    const result = await this.api(`/v2/billing/meter/${action}`, body, auth);
    const data = z.record(z.string(), z.unknown()).parse(result.data);
    if (result.code !== 0 || (data.Response as JsonObject | undefined)?.Error)
      throw new Error("WorkBuddy 未接受积分或签到操作。");
    return data;
  }

  async checkinStatus(auth: WorkbuddyAuth): Promise<NonNullable<WorkbuddyBenefits["checkin"]>> {
    const status = z
      .object({
        active: z.boolean(),
        today_checked_in: z.boolean(),
        streak_days: z.unknown().optional(),
        today_credit: z.unknown().optional(),
        total_credits: z.unknown().optional(),
        theme_name: z.string().optional(),
        checkin_dates: z.array(z.string()).optional(),
      })
      .parse(await this.billing("checkin-activity-status", auth));
    return {
      active: status.active,
      todayCheckedIn: status.today_checked_in,
      streakDays: numeric(status.streak_days),
      todayCredit: numeric(status.today_credit),
      totalCredits: numeric(status.total_credits),
      title: (status.theme_name || "Buddy加油站").slice(0, 200),
      dates: (status.checkin_dates ?? [])
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .slice(0, 31),
    };
  }

  async credits(auth: WorkbuddyAuth): Promise<NonNullable<WorkbuddyBenefits["credits"]>> {
    const accounts: JsonObject[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.billing("get-user-resource", auth, {
        PageNumber: page,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
      });
      const data = z
        .object({
          Response: z.object({
            Data: z.object({
              Accounts: z.array(z.record(z.string(), z.unknown())),
              TotalCount: z.unknown().optional(),
            }),
          }),
        })
        .parse(result).Response.Data;
      accounts.push(...data.Accounts);
      const total = numeric(data.TotalCount);
      if (total === null ? data.Accounts.length < 100 : accounts.length >= total)
        return parseCredits(accounts);
      if (!data.Accounts.length) break;
    }
    throw new Error("WorkBuddy 未返回完整积分资源包。");
  }

  async snapshot(auth: WorkbuddyAuth, previous?: WorkbuddyBenefits): Promise<WorkbuddyBenefits> {
    const [credits, checkin] = await Promise.allSettled([
      this.credits(auth),
      this.checkinStatus(auth),
    ]);
    return {
      credits: credits.status === "fulfilled" ? credits.value : (previous?.credits ?? null),
      creditsError: credits.status === "rejected" ? "积分查询失败，请刷新账号后重试。" : "",
      checkin: checkin.status === "fulfilled" ? checkin.value : (previous?.checkin ?? null),
      checkinError: checkin.status === "rejected" ? "签到状态查询失败，请稍后重试。" : "",
      checkedAt: Date.now(),
    };
  }
}

export function unwrapData(result: JsonObject): unknown {
  const data = result.data;
  return data && typeof data === "object" && "data" in data ? data.data : data;
}

function numeric(value: unknown): number | null {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string" || !value) return 0;
  const text = value.replace(" ", "T");
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}+08:00`) || 0;
}

export function parseCredits(
  accounts: JsonObject[],
  now = Date.now(),
): NonNullable<WorkbuddyBenefits["credits"]> {
  const packages = accounts.flatMap((item) => {
    const ends = [item.DeductionEndTime, item.ExpiredTime, item.CycleEndTime]
      .map(timestamp)
      .filter((n) => n > 0);
    const end = ends.length ? Math.min(...ends) : 0;
    const start = Math.max(timestamp(item.DeductionStartTime), timestamp(item.CycleStartTime));
    if (
      Number(item.Status) !== 0 ||
      start > now ||
      (end && end <= now) ||
      (item.CapacityUnit && item.CapacityUnit !== "credits")
    )
      return [];
    const remaining = numeric(
      item.CycleCapacityRemainPrecise ??
        item.CycleCapacityRemain ??
        item.CapacityRemainPrecise ??
        item.CapacityRemain,
    );
    if (remaining === null || remaining < 0) throw new Error("WorkBuddy 积分资源包格式已变化。");
    return [
      {
        name: String(item.PackageName || "积分包").slice(0, 200),
        remaining,
        total: numeric(
          item.CycleCapacitySizePrecise ?? item.CycleCapacitySize ?? item.CapacitySize,
        ),
        expiresAt: end || null,
      },
    ];
  });
  return { remaining: packages.reduce((sum, item) => sum + item.remaining, 0), packages };
}
