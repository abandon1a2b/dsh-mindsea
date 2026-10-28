import { z } from "zod";
import { timestamp } from "./common.ts";
export const eventSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200),
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string().trim().min(1).max(100_000),
    occurredAt: timestamp.optional(),
  })
  .strict();
export type Event = z.infer<typeof eventSchema> & {
  id: string;
  userId: string;
  occurredAt: string;
};
