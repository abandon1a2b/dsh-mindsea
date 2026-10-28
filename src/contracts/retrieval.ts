import { z } from "zod";
import type { Item } from "./items.ts";
export const querySchema = z
  .object({
    query: z.string().max(1000).default(""),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export const contextSchema = querySchema.extend({
  maxChars: z.number().int().min(100).max(40_000).default(12_000),
});

export interface ContextGroups {
  due: Item[];
  openLoops: Item[];
  relevant: Item[];
}
export interface ContextResult {
  candidates: ContextGroups;
  candidateChars: number;
  omitted: number;
  policy: string;
}
export interface ContextResponse extends ContextResult {
  reconciliationPending: boolean;
}
