import type { Context } from "@deepseek-ai/cordis";
import type { Config } from "./config.ts";
import type { DecideAgendaChanges } from "../../../src/application/reconcile-events.ts";
import { reconciliationSchema } from "../../../src/contracts/agenda.ts";
import { RECONCILIATION_PROMPT } from "./prompts.ts";
export function makeDecider(ctx: Context, config: Config): DecideAgendaChanges {
  return async (input) => {
    const content = JSON.stringify({
      event: input.event,
      recentEvents: input.recentEvents,
      agenda: input.agenda,
      timeZone: config.timeZone,
    });
    if (content.length > 80000)
      throw new Error("Mindsea maintenance context exceeds budget");
    let text = "";
    let finished = false;
    const signal = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(input.signal ? [input.signal] : []),
    ]);
    for await (const chunk of ctx.llm.stream({
      provider: config.provider,
      model: config.model,
      system: RECONCILIATION_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: content }] }],
      maxTokens: 4096,
      signal,
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
      if (text.length > 100000)
        throw new Error("Mindsea maintenance output exceeds budget");
      if (chunk.type === "finish" && chunk.reason.kind === "stop") finished = true;
    }
    if (!finished) throw new Error("Mindsea maintenance response incomplete");
    const result = reconciliationSchema.parse({
      ...JSON.parse(text),
      agendaRevision: input.agendaRevision,
    });
    if (
      input.event.role === "assistant" &&
      (result.creates.length ||
        result.updates.some((update) => {
          const old = input.agenda.find((item) => item.id === update.id);
          return (
            !old ||
            old.status !== "pending" ||
            update.item.status !== "followed_up" ||
            update.item.content !== old.content ||
            (update.item.followUpAt ?? null) !== (old.followUpAt ?? null)
          );
        }))
    )
      throw new Error("Assistant event cannot change user plans");
    return { updates: result.updates, creates: result.creates };
  };
}
