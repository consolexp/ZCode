import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkbuddyCreditsProps } from "./contract.js";
import { useWorkbuddy } from "./useWorkbuddy.js";

export function WorkbuddyCredits({ providerId, sessionId }: WorkbuddyCreditsProps) {
  const { state, error } = useWorkbuddy(providerId, sessionId);
  const { intl, locale } = useZCodeIntl();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  if (error || !state?.connected) return null;
  const usage = state.usage;
  const text =
    usage && (usage.reportedRequests > 0 || usage.credits > 0)
      ? intl.formatMessage(
          { id: "workbuddy.sessionUsage" },
          { credits: number.format(usage.credits) },
        )
      : intl.formatMessage({ id: "workbuddy.usagePending" });
  const help =
    intl.formatMessage({ id: "workbuddy.usageHelp" }) +
    (usage?.unreportedRequests
      ? ` ${intl.formatMessage({ id: "workbuddy.unreported" }, { count: usage.unreportedRequests })}`
      : "");
  return (
    <span
      title={help}
      data-testid="workbuddy-session-credits"
      className="truncate text-ui-caption text-foreground-subtle"
    >
      {text}
      {usage?.unreportedRequests ? " *" : ""}
    </span>
  );
}
