import { z } from "zod";
import { timestamp } from "./common.ts";
import type { Event } from "./events.ts";

export const MEMORY_POLICY = "memory-v1";
const id = z.string().min(1).max(200);
export const evidenceSchema = z
  .object({
    eventId: id,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    relation: z.enum(["supports", "contradicts"]).default("supports"),
  })
  .strict()
  .refine((value) => value.end > value.start, "Evidence interval is empty");
export const memoryRefSchema = z
  .object({ id, version: z.number().int().positive() })
  .strict();
export const scopeSchema = z
  .object({
    kind: z.enum(["global", "topic", "relationship", "project"]),
    key: id,
  })
  .strict()
  .refine(
    (value) => value.kind !== "global" || value.key === "*",
    "Global scope key must be *",
  );
const fields = {
  subjectId: id.default("self"),
  scope: scopeSchema.default({ kind: "global", key: "*" }),
  topic: id,
  content: z.string().trim().min(1).max(12000),
  basis: z.enum(["explicit", "inferred"]),
  status: z.enum(["candidate", "active"]).default("active"),
  evidence: z.array(evidenceSchema).min(1).max(100),
  dependencies: z.array(memoryRefSchema).max(100).default([]),
  validFrom: timestamp.nullable().default(null),
  validTo: timestamp.nullable().default(null),
  reviewAfter: timestamp.nullable().default(null),
};
export const memoryInputSchema = z
  .discriminatedUnion("layer", [
    z
      .object({
        ...fields,
        layer: z.literal("L1"),
        kind: z.enum(["episode", "fact"]),
        claim: z
          .object({ predicate: id, value: z.string().min(1).max(2000) })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({ ...fields, layer: z.literal("L2"), kind: z.literal("topic-summary") })
      .strict(),
    z
      .object({
        ...fields,
        layer: z.literal("L3"),
        kind: z.enum(["preference", "habit", "long-term-goal", "relationship"]),
        claim: z.object({ predicate: id, value: z.string().min(1).max(2000) }).strict(),
        confirmation: evidenceSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.validFrom && value.validTo && value.validFrom >= value.validTo)
      ctx.addIssue({ code: "custom", message: "validTo must be after validFrom" });
    if (value.layer === "L1" && value.dependencies.length)
      ctx.addIssue({ code: "custom", message: "L1 depends directly on events" });
    if (value.layer !== "L1" && !value.dependencies.length)
      ctx.addIssue({
        code: "custom",
        message: "Derived memories need lower-layer dependencies",
      });
  });
export type Evidence = z.infer<typeof evidenceSchema>;
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type MemoryStatus =
  "candidate" | "active" | "disputed" | "superseded" | "expired" | "retracted";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type MemoryRecord = DistributiveOmit<MemoryInput, "status"> & {
  id: string;
  userId: string;
  version: number;
  status: MemoryStatus;
  recordedAt: string;
  updatedAt: string;
  policyVersion: string;
  extractorVersion: string;
  rootEventIds: string[];
  independentEvidenceCount: number;
  revisionSet: number;
  triggerEventId: string;
  reason: string;
};
export const memoryPlanSchema = z
  .object({
    extractorVersion: id,
    writes: z
      .array(
        z
          .object({
            key: id,
            id: id.optional(),
            version: z.number().int().positive().optional(),
            record: memoryInputSchema,
          })
          .strict()
          .refine(
            (v) => Boolean(v.id) === Boolean(v.version),
            "Update requires id and version",
          ),
      )
      .max(50),
    invalidations: z
      .array(
        z
          .object({
            target: memoryRefSchema,
            status: z.enum(["disputed", "superseded", "retracted"]),
            evidence: evidenceSchema,
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.writes.map((w) => w.key)).size !== plan.writes.length)
      ctx.addIssue({ code: "custom", message: "Duplicate local key" });
    const targets = [
      ...plan.writes.flatMap((w) => (w.id ? [w.id] : [])),
      ...plan.invalidations.map((v) => v.target.id),
    ];
    if (new Set(targets).size !== targets.length)
      ctx.addIssue({ code: "custom", message: "Duplicate target" });
  });
export type MemoryPlan = z.infer<typeof memoryPlanSchema>;
export const commitMemorySchema = z
  .object({
    token: id,
    revision: z.number().int().nonnegative(),
    plan: memoryPlanSchema,
  })
  .strict();
export interface MemoryJob {
  id: number;
  token: string;
  revision: number;
  event: Event;
  recentEvents: Event[];
  records: MemoryRecord[];
  policyVersion: string;
  leaseUntil: string;
}
export const memoryQuerySchema = z
  .object({
    query: z.string().max(1000).default(""),
    intent: z
      .enum(["auto", "preference", "history", "topic", "exact-quote"])
      .default("auto"),
    scope: scopeSchema.optional(),
    layers: z
      .array(z.enum(["L1", "L2", "L3"]))
      .min(1)
      .max(3)
      .default(["L1", "L2", "L3"]),
    limit: z.number().int().min(1).max(100).default(10),
    maxChars: z.number().int().min(100).max(40000).default(12000),
    asOf: timestamp.optional(),
    includeInactive: z.boolean().default(false),
  })
  .strict();
export type MemoryQuery = z.input<typeof memoryQuerySchema>;
export interface MemoryWatermark {
  pending: number;
  failed: number;
  lastCompletedEventId: string | null;
  revision: number;
}
export interface MemoryRecall {
  items: MemoryRecord[];
  quotes: Event[];
  omitted: number;
  watermark: MemoryWatermark;
}
export const memoryActionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    target: memoryRefSchema,
    action: z.enum(["confirm", "retract", "dispute"]),
    evidence: evidenceSchema,
    reason: z.string().min(1).max(1000),
  })
  .strict();
export const forgetSchema = z
  .object({ eventIds: z.array(id).min(1).max(100) })
  .strict();
