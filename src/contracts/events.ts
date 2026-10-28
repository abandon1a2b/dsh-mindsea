import { z } from "zod";
import { timestamp } from "./common.ts";
export const eventSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200),
    role: z.enum(["user", "assistant", "tool"]),
    content: z
      .string()
      .min(1)
      .max(100_000)
      .refine((value) => value.trim().length > 0, "Empty message"),
    occurredAt: timestamp.optional(),
    producer: z.string().min(1).max(200).optional(),
  })
  .strict();
export type Event = z.infer<typeof eventSchema> & {
  id: string;
  userId: string;
  occurredAt: string;
  recordedAt?: string;
  sourceKind?: "human" | "assistant" | "tool";
};
