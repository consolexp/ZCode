import type { WorkbuddyAccountView } from "./contract.js";

type Model = NonNullable<WorkbuddyAccountView["models"]>[number];
type Promotion = NonNullable<Model["promotions"]>[number];

function minute(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60)
    return Number(match[1]) * 60 + Number(match[2]);
}

export function promotionActive(promotion: Promotion, now: Date): boolean {
  const schedule = promotion.schedule;
  if (schedule?.validFrom && now.getTime() < Date.parse(schedule.validFrom)) return false;
  if (schedule?.validUntil && now.getTime() >= Date.parse(schedule.validUntil)) return false;
  if (!schedule?.daily?.length) return true;
  let current = now.getHours() * 60 + now.getMinutes();
  if (schedule.timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: schedule.timezone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(now);
      current =
        (Number(parts.find((p) => p.type === "hour")?.value) % 24) * 60 +
        Number(parts.find((p) => p.type === "minute")?.value);
    } catch {
      /* 官方对无效时区回退本地时间。 */
    }
  }
  return schedule.daily.some((window) => {
    const start = minute(window.start),
      end = minute(window.end);
    return (
      start !== undefined &&
      end !== undefined &&
      (start === end ||
        (start < end ? current >= start && current < end : current >= start || current < end))
    );
  });
}

function parseCredits(text?: string) {
  if (!text?.trim()) return;
  const value = text.trim();
  const match = /^(\d+(?:\.\d+)?)(.*)$/.exec(value) ?? /^x\s*(\d+(?:\.\d+)?)$/i.exec(value);
  if (!match || !Number.isFinite(Number(match[1]))) return;
  const suffix = match[2] ?? "x";
  return {
    number: Number(match[1]),
    decimals: match[1]!.split(".")[1]?.length ?? 0,
    suffix,
    display: `${match[1]}${suffix}`,
  };
}

export function discountCredits(credits: string | undefined, discount: Promotion["discount"]) {
  if (!discount) return;
  const original = parseCredits(credits);
  const explicit = discount.discountedCredits?.trim();
  if (explicit && credits?.trim()) {
    const parsed = parseCredits(explicit);
    return {
      original: original?.display ?? credits.trim(),
      discounted: parsed
        ? `${parsed.number.toFixed(Math.max(2, parsed.decimals, original?.decimals ?? 0))}${parsed.suffix}`
        : explicit,
      displayMode: discount.displayMode ?? "strikethrough",
    };
  }
  if (
    !original ||
    typeof discount.factor !== "number" ||
    discount.factor <= 0 ||
    discount.factor >= 1
  )
    return;
  const value = original.number * discount.factor;
  let decimals = 0;
  while (decimals < 4 && Number(value.toFixed(decimals)) !== Number(value.toFixed(4))) decimals++;
  return {
    original: original.display,
    discounted: `${value.toFixed(Math.max(original.decimals, decimals))}${original.suffix}`,
    displayMode: discount.displayMode ?? "strikethrough",
  };
}

export function modelPromotion(model: Model, locale: string, now = new Date()) {
  const zh = locale.startsWith("zh");
  const localized = (cn?: string, en?: string) => (zh ? cn || en : en || cn);
  const enabled = (model.promotions ?? []).filter((p) => p.enabled !== false);
  const byPriority = (a: Promotion, b: Promotion) => (b.priority ?? 0) - (a.priority ?? 0);
  const primary =
    enabled.filter((p) => promotionActive(p, now)).sort(byPriority)[0] ??
    [...enabled].sort(byPriority)[0];
  const active = primary && promotionActive(primary, now);
  const badge = primary?.badge;
  const badgeLabel =
    badge &&
    (zh
      ? badge.shortLabel || badge.label || badge.shortLabelEn || badge.labelEn
      : badge.shortLabelEn || badge.labelEn || badge.shortLabel || badge.label);
  const tier = model.tier?.enabled !== false ? model.tier : undefined;
  const rank: Record<string, number> = {
    free: 1,
    youth: 1,
    trial: 1,
    standard: 2,
    advanced: 3,
    flagship: 4,
  };
  return {
    badge:
      badge && (active || badge.display === "always") && badgeLabel
        ? { ...badge, label: badgeLabel }
        : undefined,
    credits:
      active && primary.kind === "discount"
        ? discountCredits(model.credits, primary.discount)
        : undefined,
    text: active ? localized(primary.hover?.textZh, primary.hover?.textEn) : undefined,
    action: active ? primary.hover?.action : undefined,
    actionLabel: active
      ? localized(primary.hover?.action?.labelZh, primary.hover?.action?.labelEn)
      : undefined,
    tierBadge: tier?.badge ? localized(tier.badge.label, tier.badge.labelEn) : undefined,
    tierText: localized(tier?.hover?.textZh, tier?.hover?.textEn),
    tierAction:
      tier &&
      (rank[model.userType ?? "free"] ?? 1) <
        (rank[tier.requiredUserType ?? tier.tier ?? "standard"] ?? 2)
        ? localized(tier.hover?.action?.labelZh, tier.hover?.action?.labelEn)
        : undefined,
  };
}

export function nextPromotionDelay(model: Model, now = Date.now()): number {
  // 整分钟覆盖官方 daily 边界；有效期的秒级边界单独调度，长时间睡眠由 focus/visibility 补偿。
  let delay = 60000 - (now % 60000);
  for (const p of model.promotions ?? []) {
    for (const date of [p.schedule?.validFrom, p.schedule?.validUntil]) {
      const difference = date ? Date.parse(date) - now : 0;
      if (difference > 0) delay = Math.min(delay, difference);
    }
  }
  return Math.max(50, delay);
}
