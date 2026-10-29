import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { authSchema } from "./upstream.js";
import type { WorkbuddyCipher } from "./contract.js";
import { promotionSchema } from "./metadata.js";

const number = z.number().finite();
const usage = z.object({
  credits: number.nonnegative(),
  reportedRequests: number.int().nonnegative(),
  unreportedRequests: number.int().nonnegative(),
  updatedAt: number,
});
const benefits = z.object({
  credits: z
    .object({
      remaining: number,
      packages: z.array(
        z.object({
          name: z.string(),
          remaining: number,
          total: number.nullable(),
          expiresAt: number.nullable(),
        }),
      ),
    })
    .nullable(),
  creditsError: z.string(),
  checkin: z
    .object({
      active: z.boolean(),
      todayCheckedIn: z.boolean(),
      streakDays: number.nullable(),
      todayCredit: number.nullable(),
      totalCredits: number.nullable(),
      title: z.string(),
      dates: z.array(z.string()),
    })
    .nullable(),
  checkinError: z.string(),
  checkedAt: number,
});
export const modelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  credits: z.string().max(100).optional(),
  description: z.string().max(4000).optional(),
  descriptionZh: z.string().max(4000).optional(),
  descriptionEn: z.string().max(4000).optional(),
  badges: z.array(z.string().max(200)).max(20).optional(),
  promotions: z.array(promotionSchema).max(1000).optional(),
  tier: promotionSchema.optional(),
  userType: z.string().max(50).optional(),
  contextWindow: number.int().positive().optional(),
  contextWindows: z.array(number.int().positive()).max(20).optional(),
  maxInputTokens: number.int().positive().optional(),
  maxOutputTokens: number.int().positive().optional(),
  supportsImages: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  reasoning: z
    .object({
      defaultEffort: z.string().max(30).optional(),
      supportedEfforts: z.array(z.string().max(30)).max(20),
      canDisableThinking: z.boolean().optional(),
    })
    .optional(),
  busyLevel: z.enum(["idle", "normal", "busy", "congested", "unavailable", "unknown"]).optional(),
  disabled: z.boolean().optional(),
  disabledReason: z.string().max(1000).optional(),
});
const accountSchema = z.object({
  generation: z.string(),
  allowModelFallback: z.boolean().optional(),
  claimUncertain: z.boolean().optional(),
  secret: z.string().min(32),
  auth: authSchema.optional(),
  pending: z
    .object({ id: z.string(), state: z.string(), authUrl: z.string().url(), expiresAt: number })
    .optional(),
  benefits: benefits.optional(),
  message: z.string().optional(),
  profileError: z.string().optional(),
  autoAttemptDay: z.string().optional(),
  models: z.array(modelSchema).optional(),
  modelSource: z.enum(["account", "snapshot"]).optional(),
  modelSyncError: z.string().optional(),
  modelDetailsUpdatedAt: number.optional(),
  modelDetailsError: z.string().optional(),
  usage: z.record(z.string(), usage).default({}),
});
const stateSchema = z.object({
  version: z.literal(1),
  port: number.int().min(0).max(65535),
  accounts: z.record(z.string(), accountSchema),
});
export type WorkbuddyState = z.infer<typeof stateSchema>;
export type WorkbuddyAccount = z.infer<typeof accountSchema>;

export class WorkbuddyStateStore {
  constructor(
    readonly path: string,
    private readonly cipher: WorkbuddyCipher,
  ) {}

  async read(): Promise<WorkbuddyState> {
    try {
      return stateSchema.parse(JSON.parse(this.cipher.decrypt(await readFile(this.path, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, port: 0, accounts: {} };
      // 损坏凭据不能按空文件处理，否则会静默覆盖所有账号。
      throw new Error("WorkBuddy 账号文件不可读取，请备份后检查文件。");
    }
  }

  save(state: WorkbuddyState): Promise<void> {
    return atomicWritePrivateTextFile(
      this.path,
      this.cipher.encrypt(JSON.stringify(stateSchema.parse(state))),
    );
  }

  update<T>(operation: (state: WorkbuddyState) => Promise<T>): Promise<T> {
    return withFileLock(
      this.path,
      async () => {
        const state = await this.read();
        try {
          return await operation(state);
        } finally {
          await this.save(state);
        }
      },
      { lockMaxWaitMs: 240_000 },
    );
  }
}
