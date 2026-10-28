import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import type { MindseaClient } from "../../../src/client/index.ts";
import { memoryQuerySchema } from "../../../src/contracts/memory.ts";
import { eventId } from "./event-buffer.ts";

export function registerMemoryTools(
  ctx: Context,
  enabled: (id: string) => boolean,
  clientFor: (signal: AbortSignal) => MindseaClient,
) {
  const output = {
    schema: { type: "string" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: String(value) },
    ],
  };
  const client = (agent: Agent | undefined, signal: AbortSignal) => {
    if (!agent || !enabled(agent.id))
      throw new Error("Mindsea is not enabled for this session");
    return clientFor(signal);
  };
  const currentEvidence = async (agent: Agent | undefined, signal: AbortSignal) => {
    const api = client(agent, signal);
    const source = agent!.session
      .snapshotEvents()
      .findLast(
        (event) => event.type === "user/message" && event.data.source.kind === "user",
      );
    if (!source || source.type !== "user/message")
      throw new Error("A committed user statement is required");
    const content = source.data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (!content.trim()) throw new Error("No textual user evidence");
    const id = eventId(agent!.id, source.data.id);
    await api.record({
      id,
      sessionId: agent!.id,
      role: "user",
      content,
      producer: "dsh",
    });
    return { api, evidence: await api.evidence(id) };
  };
  const disposers = [
    ctx.tools.register({
      name: "mindsea_recall",
      description:
        "Passively query L1 facts, L2 topics or L3 profiles, with evidence. Use exact-quote for original messages. Never infer facts from pending/failed extraction. Not required every turn.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          intent: {
            type: "string",
            enum: ["auto", "preference", "history", "topic", "exact-quote"],
          },
          scope: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["global", "topic", "relationship", "project"],
              },
              key: { type: "string" },
            },
            required: ["kind", "key"],
            additionalProperties: false,
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          includeInactive: {
            type: "boolean",
            description:
              "Only for explicit memory review: include candidates/disputed/superseded records; these are not current facts.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const input = memoryQuerySchema.parse(args);
        return JSON.stringify(await client(exec.agent, exec.signal).memoryQuery(input));
      },
    }),
    ctx.tools.register({
      name: "mindsea_remember",
      description:
        "Save a confirmed fact as L1 with the latest committed user statement as evidence. Do not save guesses, assistant claims or jokes. Background consolidation handles topics and profiles.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const input = z
          .object({ content: z.string().trim().min(1).max(12000) })
          .strict()
          .parse(args);
        const { api, evidence } = await currentEvidence(exec.agent, exec.signal);
        return JSON.stringify(await api.rememberEvidence(input.content, evidence));
      },
    }),
    ctx.tools.register({
      name: "mindsea_memory_action",
      description:
        "Confirm a specific inferred L3 candidate, retract a memory, or dispute incorrect knowledge using the current explicit user statement. Only act when the user actually confirms/corrects this record.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer" },
          action: { type: "string", enum: ["confirm", "retract", "dispute"] },
          reason: { type: "string" },
        },
        required: ["id", "version", "action", "reason"],
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const input = z
          .object({
            id: z.string().min(1),
            version: z.number().int().positive(),
            action: z.enum(["confirm", "retract", "dispute"]),
            reason: z.string().min(1).max(1000),
          })
          .strict()
          .parse(args);
        const { api, evidence } = await currentEvidence(exec.agent, exec.signal);
        const { watermark } = await api.memoryJobs();
        return JSON.stringify(
          await api.memoryAction({
            revision: watermark.revision,
            target: { id: input.id, version: input.version },
            action: input.action,
            evidence,
            reason: input.reason,
          }),
        );
      },
    }),
    ctx.tools.register({
      name: "mindsea_memory_inspect",
      description:
        "Inspect a memory and its versions to find source evidence, candidate confirmation targets and correction history. Historical records are not necessarily current facts.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const { id } = z
          .object({ id: z.string().min(1) })
          .strict()
          .parse(args);
        return JSON.stringify(await client(exec.agent, exec.signal).memoryHistory(id));
      },
    }),
    ctx.tools.register({
      name: "mindsea_forget",
      description:
        "Only on an explicit user request to forget specified source events: erase their retained content and derived memories, redact linked plans/history and prevent source replay. This is irreversible; do not use for ordinary corrections.",
      parameters: {
        type: "object",
        properties: {
          eventIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
          },
        },
        required: ["eventIds"],
        additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        const { eventIds } = z
          .object({ eventIds: z.array(z.string().min(1)).min(1).max(100) })
          .strict()
          .parse(args);
        return JSON.stringify(
          await client(exec.agent, exec.signal).forgetEvents(eventIds),
        );
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
