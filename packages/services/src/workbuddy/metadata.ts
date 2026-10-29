import { z } from "zod";

const text = z.string().max(4000);
export const promotionSchema = z.object({
  id: z.string().min(1).max(200),
  modelIds: z.array(z.string().max(200)).max(1000).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().finite().optional(),
  kind: z.string().max(50).optional(),
  badge: z
    .object({
      label: text.optional(),
      labelEn: text.optional(),
      shortLabel: text.optional(),
      shortLabelEn: text.optional(),
      color: z
        .string()
        .regex(/^#[\da-f]{3,8}$/i)
        .optional()
        .catch(undefined),
      icon: z
        .string()
        .max(80000)
        .regex(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/)
        .optional()
        .catch(undefined),
      display: z.string().max(30).optional(),
    })
    .optional(),
  hover: z
    .object({
      textZh: text.optional(),
      textEn: text.optional(),
      action: z
        .object({
          type: z.string().max(50),
          labelZh: text.optional(),
          labelEn: text.optional(),
        })
        .optional(),
    })
    .optional(),
  discount: z
    .object({
      factor: z.number().finite().optional(),
      discountedCredits: z.string().max(100).optional(),
      displayMode: z.enum(["replace", "strikethrough"]).optional(),
    })
    .optional(),
  schedule: z
    .object({
      timezone: z.string().max(100).optional(),
      validFrom: z.string().max(100).optional(),
      validUntil: z.string().max(100).optional(),
      daily: z
        .array(z.object({ start: z.string().max(20), end: z.string().max(20) }))
        .max(100)
        .optional(),
    })
    .optional(),
  tier: z.string().max(50).optional(),
  requiredUserType: z.string().max(50).optional(),
});

export const productMetadataSchema = z.object({
  modelPromotions: z.array(promotionSchema).max(1000).default([]),
  modelTiers: z.array(promotionSchema).max(1000).default([]),
});
