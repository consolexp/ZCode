import { describe, expect, it } from "vitest";
import {
  discountCredits,
  modelPromotion,
  promotionActive,
  nextPromotionDelay,
} from "@/workbuddy/modelPromotion.js";

const night = {
  id: "night",
  kind: "discount",
  priority: 100,
  badge: {
    label: "夜间折扣",
    labelEn: "Night discount",
    shortLabel: "夜折",
    shortLabelEn: "Night",
  },
  discount: { factor: 0.5 },
  schedule: { timezone: "Asia/Shanghai", daily: [{ start: "23:00", end: "7:50" }] },
  hover: {
    textZh: "官方活动原文",
    textEn: "Official promotion",
    action: { type: "selectModel", labelZh: "去使用", labelEn: "Use now" },
  },
};
describe("WorkBuddy官方活动规则", () => {
  it("遵循时区、跨午夜和左右边界，结束时间以配置7:50为准", () => {
    expect(promotionActive(night, new Date("2026-10-28T22:59:59+08:00"))).toBe(false);
    expect(promotionActive(night, new Date("2026-10-28T23:00:00+08:00"))).toBe(true);
    expect(promotionActive(night, new Date("2026-10-29T07:49:59+08:00"))).toBe(true);
    expect(promotionActive(night, new Date("2026-10-29T07:50:00+08:00"))).toBe(false);
    const limited = {
      ...night,
      schedule: { validFrom: "2026-10-28T00:00:00Z", validUntil: "2026-10-29T00:00:00Z" },
    };
    expect(promotionActive(limited, new Date("2026-10-28T00:00:00Z"))).toBe(true);
    expect(promotionActive(limited, new Date("2026-10-29T00:00:00Z"))).toBe(false);
  });
  it("显式0优先于factor；官方显示精度、replace和划线语义", () => {
    expect(
      discountCredits("x1.5", { discountedCredits: "0x", factor: 0.5, displayMode: "replace" }),
    ).toEqual({ original: "1.5x", discounted: "0.00x", displayMode: "replace" });
    expect(discountCredits("0.250x", { discountedCredits: "0.1x" })?.discounted).toBe("0.100x");
    expect(discountCredits("x1.5", { factor: 0.5 })?.discounted).toBe("0.75x");
    expect(discountCredits("2x", { factor: 0 })).toBeUndefined();
    expect(discountCredits(undefined, { discountedCredits: "0x" })).toBeUndefined();
  });
  it("活跃活动优先后按priority，同优先级保持配置顺序；失效活动隐藏", () => {
    const expired = {
      ...night,
      id: "expired",
      priority: 999,
      schedule: { validUntil: "2026-10-01T00:00:00Z" },
    };
    const model = {
      id: "glm",
      name: "GLM",
      credits: "x1",
      promotions: [expired, { ...night, id: "disabled", enabled: false, priority: 1000 }, night],
    };
    const cn = modelPromotion(model, "zh-CN", new Date("2026-10-28T23:00:00+08:00"));
    expect(cn.badge?.label).toBe("夜折");
    expect(cn.credits?.discounted).toBe("0.5x");
    expect(cn.text).toBe("官方活动原文");
    const en = modelPromotion(model, "en-US", new Date("2026-10-28T23:00:00+08:00"));
    expect(en.badge?.label).toBe("Night");
    expect(en.actionLabel).toBe("Use now");
    expect(modelPromotion({ ...model, promotions: [expired] }, "zh-CN").badge).toBeUndefined();
    expect(
      modelPromotion(
        { ...model, promotions: [{ ...expired, badge: { label: "预告", display: "always" } }] },
        "zh-CN",
      ).badge?.label,
    ).toBe("预告");
    expect(
      modelPromotion(
        { ...model, promotions: [night, { ...night, badge: { label: "第二条" } }] },
        "zh-CN",
        new Date("2026-10-28T23:00:00+08:00"),
      ).badge?.label,
    ).toBe("夜折");
  });
  it("订阅等级控制升级动作，边界定时包含有效期秒数", () => {
    const model = {
      id: "glm",
      name: "GLM",
      userType: "advanced",
      tier: {
        id: "tier",
        tier: "standard",
        badge: { label: "订阅优先" },
        hover: { textZh: "资源紧张", action: { type: "upgrade", labelZh: "去升级" } },
      },
      promotions: [{ id: "trial", schedule: { validUntil: "2026-10-28T00:00:15Z" } }],
    };
    expect(modelPromotion(model, "zh-CN").tierAction).toBeUndefined();
    expect(modelPromotion({ ...model, userType: "free" }, "zh-CN").tierAction).toBe("去升级");
    expect(nextPromotionDelay(model, Date.parse("2026-10-28T00:00:00Z"))).toBe(15000);
  });
});
