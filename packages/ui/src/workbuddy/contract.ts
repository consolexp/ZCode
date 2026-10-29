import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { useServices } from "@/hooks/useServices.js";

type ExecuteWorkbuddy = NonNullable<
  ReturnType<typeof useServices>["providerSettingsService"]["workbuddy"]
>;
export type WorkbuddyAccountView = Awaited<ReturnType<ExecuteWorkbuddy>>;
export type WorkbuddyCommand = Parameters<ExecuteWorkbuddy>[0];
export interface WorkbuddyModelInfoProps {
  model: NonNullable<WorkbuddyAccountView["models"]>[number];
  updatedAt?: number;
  error?: string;
  onSelect?: () => void;
}

export interface WorkbuddyPanelProps {
  provider: ProviderSettingsFormProvider;
  onSave: (provider: ProviderSettingsFormProvider) => Promise<unknown> | void;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
}

export interface WorkbuddyCreditsProps {
  providerId: string;
  sessionId: string;
}
