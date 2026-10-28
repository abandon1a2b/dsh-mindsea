import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import type { MindseaClient } from "../../../src/client/index.ts";
import type { Config } from "./config.ts";
import type { EventBuffer } from "./event-buffer.ts";
import { waitForMaintenance } from "./maintenance.ts";
import { futureText } from "./future-context.ts";
export function registerFutureHook(
  ctx: Context,
  config: Config,
  enabled: (id: string) => boolean,
  buffer: EventBuffer,
  pump: () => Promise<void>,
  clientFor: (signal: AbortSignal, timeoutMs?: number) => MindseaClient,
  warn: () => void,
) {
  const checkedTurn = new WeakMap<Agent, number>();
  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || !enabled(payload.agent.id)) return decision;
    const userMessages = payload.messages.filter(
      (message) => message.source.kind === "user",
    );
    // Once each conversation turn; new mid-turn user steering also warrants a fresh check.
    if (checkedTurn.get(payload.agent) === payload.turn && !userMessages.length)
      return decision;
    checkedTurn.set(payload.agent, payload.turn);
    buffer.replay(payload.agent.session);
    for (const message of userMessages) buffer.enqueue(payload.agent.id, message);
    await waitForMaintenance(
      (async () => {
        await pump();
        if (buffer.hasPending()) await pump();
      })(),
      config.hookBudgetMs,
      payload.signal,
    );
    if (payload.signal.aborted) return decision;
    try {
      // If ingestion has not finished, the server may not yet know that its state is stale.

      const scopedClient = clientFor(payload.signal, 2000);
      const result = await scopedClient.futureCheck();
      if (buffer.hasPending()) return decision;
      const text = futureText(result, payload.turn);
      if (!text) return decision;
      const message: UserMessage = createMessage({
        role: "user",
        source: {
          kind: "mindsea-future",
          form: "notice",
          summary: "Mindsea Future candidates for this turn",
        },
        content: [{ type: "text", text }],
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch {
      warn();
      return decision;
    }
  });
}
