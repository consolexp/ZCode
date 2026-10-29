import type { WorkbuddyModelInfoProps } from "./contract.js";
import { useModelPromotion } from "./useModelPromotion.js";

const compactCredits = (value: string | undefined) => value?.replace(/\s*credits\s*$/i, "").trim();

export function WorkbuddyModelSummary({ model }: Pick<WorkbuddyModelInfoProps, "model">) {
  const display = useModelPromotion(model);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-ui-sm">
      {display.badge && (
        <span
          className="inline-flex items-center gap-1 rounded px-1"
          style={{
            color: display.badge.color,
            background: display.badge.color
              ? `color-mix(in srgb, ${display.badge.color} 10%, transparent)`
              : undefined,
          }}
        >
          {display.badge.icon && <img src={display.badge.icon} alt="" className="size-3" />}
          {display.badge.label}
        </span>
      )}
      {display.tierBadge && (
        <span className="rounded bg-secondary px-1 text-foreground-subtle">
          {display.tierBadge}
        </span>
      )}
      <span className="text-foreground-subtle">
        {display.credits ? (
          <>
            {display.credits.displayMode === "strikethrough" && (
              <del className="mr-1 opacity-60">{compactCredits(display.credits.original)}</del>
            )}
            <span>{compactCredits(display.credits.discounted)}</span>
          </>
        ) : (
          compactCredits(model.credits)
        )}
      </span>
    </span>
  );
}
