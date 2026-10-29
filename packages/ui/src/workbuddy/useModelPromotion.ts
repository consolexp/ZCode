import { useEffect, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkbuddyModelInfoProps } from "./contract.js";
import { modelPromotion, nextPromotionDelay } from "./modelPromotion.js";

export function useModelPromotion(model: WorkbuddyModelInfoProps["model"]) {
  const { locale } = useZCodeIntl();
  const [, update] = useState(0);
  useEffect(() => {
    if (!model.promotions?.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      update((n) => n + 1);
      timer = setTimeout(refresh, nextPromotionDelay(model));
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [model]);
  return modelPromotion(model, locale);
}
