import { randomUUID } from "node:crypto";
import type { WorkbuddyAuth } from "./upstream.js";
import type { WorkbuddyAccount } from "./state.js";
import { z } from "zod";

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), name: z.string().max(200).optional() }),
  z.object({
    type: z.literal("set-model-fallback"),
    providerId: z.string().min(1).max(200),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("import-login"),
    providerId: z.string().min(1).max(200),
    text: z.string().min(1).max(65536),
  }),
  z.object({
    type: z.enum([
      "status",
      "login",
      "cancel-login",
      "refresh",
      "checkin",
      "logout",
      "sync-models",
      "export-login",
    ]),
    providerId: z.string().min(1).max(200),
    sessionId: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("poll"),
    providerId: z.string().min(1).max(200),
    loginId: z.string().min(1).max(200),
  }),
]);

export function replaceLogin(account: WorkbuddyAccount, auth: WorkbuddyAuth): void {
  account.auth = auth;
  account.generation = randomUUID();
  account.usage = {};
  for (const key of [
    "pending",
    "benefits",
    "claimUncertain",
    "autoAttemptDay",
    "models",
    "modelSource",
    "modelSyncError",
    "modelDetailsError",
    "modelDetailsUpdatedAt",
    "profileError",
    "message",
  ] as const)
    delete account[key];
}
