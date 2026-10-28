import { z } from "zod";
import { timestamp } from "./common.ts";
export const itemSchema = z
  .object({
    kind: z.enum(["memory", "future", "loop"]),
    content: z.string().trim().min(1).max(20_000),
    status: z
      .enum([
        "active",
        "superseded",
        "pending",
        "followed_up",
        "completed",
        "cancelled",
        "expired",
      ])
      .optional(),
    sourceEventId: z.string().min(1).max(200).optional(),
    followUpAt: timestamp.nullable().optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const status = item.status ?? (item.kind === "memory" ? "active" : "pending");
    const allowed =
      item.kind === "memory"
        ? ["active", "superseded", "expired"]
        : ["pending", "followed_up", "completed", "cancelled", "expired"];
    if (!allowed.includes(status))
      ctx.addIssue({
        code: "custom",
        message: "Status is invalid for this kind",
      });
    if (item.kind === "future" && status === "pending" && !item.followUpAt)
      ctx.addIssue({
        code: "custom",
        message: "Pending future requires followUpAt",
      });
    if (item.kind === "memory" && item.followUpAt)
      ctx.addIssue({
        code: "custom",
        message: "Memory cannot have followUpAt",
      });
  });
export type ItemInput = z.infer<typeof itemSchema>;
export type Item = ItemInput & {
  id: string;
  userId: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
