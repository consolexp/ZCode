import { useState, useSyncExternalStore } from "react";
import { InfoIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkbuddyModelInfoProps } from "./contract.js";
import { useModelPromotion } from "./useModelPromotion.js";
import { WorkbuddyModelSummary } from "./WorkbuddyModelSummary.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { Button } from "@/components/ui/button.js";

const subscribeWidth = (changed: () => void) => {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
};
const isNarrow = () => window.innerWidth < 640;

export function WorkbuddyModelInfo({ model, updatedAt, error, onSelect }: WorkbuddyModelInfoProps) {
  const [open, setOpen] = useState(false);
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow, () => false);
  const { intl, locale } = useZCodeIntl();
  const promotion = useModelPromotion(model);
  const platform = usePlatform();
  const t = (key: string) => intl.formatMessage({ id: `workbuddy.${key}` });
  const unknown = t("unknown");
  const formatTokens = (value?: number) =>
    value
      ? new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
          value,
        )
      : unknown;
  const level = (value: string) =>
    ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
      ? t(`effort.${value}`)
      : value;
  const badges = model.badges?.filter(
    (badge) => !(model.promotions?.length && /免费|折扣|free|discount/i.test(badge)),
  );
  const reasoning = model.reasoning;
  const efforts = reasoning?.supportedEfforts ?? [];
  const description = locale.startsWith("zh")
    ? model.descriptionZh || model.description || model.descriptionEn
    : model.descriptionEn || model.description || model.descriptionZh;
  const rows = [
    [t("multiplier"), promotion.credits?.discounted ?? model.credits ?? unknown],
    [t("busy"), t(`busy.${model.busyLevel ?? "unknown"}`)],
    [t("contextWindow"), formatTokens(model.contextWindow)],
    ...(model.contextWindows?.length
      ? [[t("supportedWindows"), model.contextWindows.map(formatTokens).join(" / ")]]
      : []),
    [t("maxInput"), formatTokens(model.maxInputTokens)],
    [t("maxOutput"), formatTokens(model.maxOutputTokens)],
    [
      t("images"),
      model.supportsImages === undefined ? unknown : t(model.supportsImages ? "yes" : "no"),
    ],
    [
      t("effort"),
      efforts.length > 1
        ? efforts.map(level).join(" / ")
        : reasoning?.defaultEffort
          ? `${level(reasoning.defaultEffort)} · ${t("fixed")}`
          : unknown,
    ],
    ...(efforts.length > 1 && reasoning?.defaultEffort
      ? [[t("defaultEffort"), level(reasoning.defaultEffort)]]
      : []),
  ];
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "workbuddy.modelDetails" }, { name: model.name })}
          data-testid={`workbuddy-model-info-${model.id}`}
          aria-expanded={open}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (["Enter", " ", "Escape"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(event.key !== "Escape");
            }
          }}
        >
          <InfoIcon aria-hidden="true" className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side={narrow ? "top" : "left"}
        align={narrow ? "end" : "start"}
        collisionPadding={12}
        className="z-[70] max-h-[min(70vh,var(--radix-hover-card-content-available-height))] w-80 max-w-[calc(100vw-24px)] overflow-y-auto"
        data-testid={`workbuddy-model-details-${model.id}`}
      >
        <div className="space-y-3">
          <div>
            <p className="break-words font-medium">{model.name}</p>
            <WorkbuddyModelSummary model={model} />
            {badges?.length ? (
              <p className="mt-1 text-ui-sm text-foreground-subtle">{badges.join(" · ")}</p>
            ) : null}
            {description ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-ui-caption text-foreground-subtle">
                {description}
              </p>
            ) : null}
          </div>
          <dl className="space-y-2 border-t border-border pt-3 text-ui-caption">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="shrink-0 text-foreground-subtle">{label}</dt>
                <dd className="min-w-0 break-words text-right">{value}</dd>
              </div>
            ))}
          </dl>
          {promotion.text && (
            <p className="whitespace-pre-wrap text-ui-caption">{promotion.text}</p>
          )}
          {promotion.action?.type === "selectModel" && promotion.actionLabel && onSelect && (
            <Button
              size="sm"
              variant="outline"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                onSelect();
              }}
            >
              {promotion.actionLabel}
            </Button>
          )}
          {promotion.tierText && <p className="text-ui-caption">{promotion.tierText}</p>}
          {promotion.tierAction && (
            <Button
              size="sm"
              variant="outline"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void platform.openExternal("https://www.workbuddy.cn/pricing?embed=1");
              }}
            >
              {promotion.tierAction}
            </Button>
          )}
          {model.disabledReason ? (
            <p className="text-ui-caption text-warning">{model.disabledReason}</p>
          ) : null}
          {error ? <p className="text-ui-caption text-warning">{t("detailsFailed")}</p> : null}
          {updatedAt ? (
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage(
                { id: "workbuddy.busyUpdated" },
                { time: new Date(updatedAt).toLocaleTimeString(locale) },
              )}
            </p>
          ) : null}
          <p className="text-ui-sm text-foreground-subtlest">{t("modelDetailsHelp")}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
