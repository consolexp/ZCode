export const WORKBUDDY_CN_ID = "workbuddy-cn";
/** 国内目录快照；同步不代表账号有额度或上游当前可用。 */
export const WORKBUDDY_CN_MODELS = ["deepseek-v4.1-flash", "hy3", "step-5-preview"] as const;

export interface WorkbuddyPromotion {
  id: string;
  modelIds?: string[];
  enabled?: boolean;
  priority?: number;
  kind?: string;
  badge?: {
    label?: string;
    labelEn?: string;
    shortLabel?: string;
    shortLabelEn?: string;
    color?: string;
    icon?: string;
    display?: string;
  };
  hover?: {
    textZh?: string;
    textEn?: string;
    action?: { type: string; labelZh?: string; labelEn?: string };
  };
  discount?: {
    factor?: number;
    discountedCredits?: string;
    displayMode?: "replace" | "strikethrough";
  };
  schedule?: {
    timezone?: string;
    validFrom?: string;
    validUntil?: string;
    daily?: { start: string; end: string }[];
  };
  tier?: string;
  requiredUserType?: string;
}

export interface WorkbuddyModel {
  id: string;
  name: string;
  credits?: string;
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  badges?: string[];
  promotions?: WorkbuddyPromotion[];
  tier?: WorkbuddyPromotion;
  userType?: string;
  contextWindow?: number;
  contextWindows?: number[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  reasoning?: { defaultEffort?: string; supportedEfforts: string[]; canDisableThinking?: boolean };
  busyLevel?: "idle" | "normal" | "busy" | "congested" | "unavailable" | "unknown";
  disabled?: boolean;
  disabledReason?: string;
}

export interface WorkbuddyUsage {
  credits: number;
  reportedRequests: number;
  unreportedRequests: number;
  updatedAt: number;
}

export interface WorkbuddyBenefits {
  credits: {
    remaining: number;
    packages: { name: string; remaining: number; total: number | null; expiresAt: number | null }[];
  } | null;
  creditsError: string;
  checkin: {
    active: boolean;
    todayCheckedIn: boolean;
    streakDays: number | null;
    todayCredit: number | null;
    totalCredits: number | null;
    title: string;
    dates: string[];
  } | null;
  checkinError: string;
  checkedAt: number;
}

/** 普通脱敏视图；只有显式 export-login 可返回 loginExport，回环密钥和授权 state 始终不返回。 */
export interface WorkbuddyAccountView {
  providerId: string;
  connected: boolean;
  accountName?: string;
  accountId?: string;
  profileError?: string;
  expiresAt?: number;
  pendingLogin?: { id: string; authUrl: string; expiresAt: number };
  benefits?: WorkbuddyBenefits;
  message?: string;
  models?: WorkbuddyModel[];
  modelSource?: "account" | "snapshot";
  modelSyncError?: string;
  modelDetailsUpdatedAt?: number;
  modelDetailsError?: string;
  usage?: WorkbuddyUsage;
  allowModelFallback?: boolean;
  /** 仅显式导出返回，禁止缓存于普通状态。 */
  loginExport?: string;
}

export type WorkbuddyCommand =
  | { type: "create"; name?: string }
  | { type: "set-model-fallback"; providerId: string; enabled: boolean }
  | { type: "import-login"; providerId: string; text: string }
  | {
      type:
        | "status"
        | "login"
        | "cancel-login"
        | "refresh"
        | "checkin"
        | "logout"
        | "sync-models"
        | "export-login";
      providerId: string;
      sessionId?: string;
    }
  | { type: "poll"; providerId: string; loginId: string };

export interface WorkbuddyPort {
  /** 持久化后返回状态；拒绝已删除渠道，重复同步保留现有模型配置。 */
  execute(command: WorkbuddyCommand): Promise<WorkbuddyAccountView>;
}

/** 使用宿主已有的凭据加密器，模块不维护另一套密钥或加密算法。 */
export interface WorkbuddyCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
