import { z } from "zod";
import { itemSchema, type Item } from "./items.ts";
import type { Event } from "./events.ts";
const agendaItemSchema = itemSchema.refine((item) => item.kind !== "memory", {
  message: "Reconciliation only accepts future or loop items",
});
export const reconciliationSchema = z
  .object({
    agendaRevision: z.number().int().nonnegative(),
    updates: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            version: z.number().int().positive(),
            item: agendaItemSchema,
          })
          .strict(),
      )
      .max(100)
      .default([]),
    creates: z.array(agendaItemSchema).max(100).default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.updates.map((update) => update.id)).size !== plan.updates.length)
      ctx.addIssue({ code: "custom", message: "Duplicate item update" });
  });
export type ReconciliationPlan = z.infer<typeof reconciliationSchema>;
export type ReconciliationJob = {
  event: Event;
  recentEvents: Event[];
  agendaRevision: number;
};
export type AgendaPage = {
  items: Item[];
  nextCursor: string | null;
  agendaRevision: number;
};

export type FutureCheck =
  | { state: "pending"; items: Item[]; omitted: number }
  | { state: "empty"; items: Item[]; omitted: number }
  | { state: "ready"; items: Item[]; omitted: number };
