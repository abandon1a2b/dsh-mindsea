import { createHash } from "node:crypto";
import type { Message } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { MindseaClient, MindseaHttpError } from "../../../src/client/index.ts";
function eventId(sessionId: string, messageId: string) {
  return `dsh:${createHash("sha256")
    .update(JSON.stringify([sessionId, messageId]))
    .digest("hex")}`;
}
function textOf(message: Message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function createEventBuffer(
  client: MindseaClient,
  enabled: (id: string) => boolean,
) {
  const pending = new Map<string, Parameters<MindseaClient["record"]>[0]>();
  const replayed = new WeakSet<Session>();
  const enqueue = (sessionId: string, message: Message, occurredAt?: string) => {
    if (!enabled(sessionId)) return;
    // Never ingest our injected context, other plugins' context, or recalled tool output as user speech.
    if (
      message.role !== "assistant" &&
      !(message.role === "user" && message.source.kind === "user")
    )
      return;
    const content = textOf(message);
    if (!content) return;
    const id = eventId(sessionId, message.id);
    pending.set(id, {
      id,
      sessionId,
      role: message.role as "user" | "assistant",
      content,
      occurredAt,
    });
  };
  const capture = (session: Session, event: SessionEvent) => {
    if (event.type === "user/message")
      enqueue(session.id, event.data, new Date(event.time).toISOString());
    if (event.type === "assistant/message" && !event.data.interrupted)
      enqueue(session.id, event.data.message, new Date(event.time).toISOString());
  };
  const replay = (session: Session) => {
    if (replayed.has(session) || !enabled(session.id)) return;
    for (const event of session.snapshotEvents()) capture(session, event);
    replayed.add(session);
  };
  const flush = async () => {
    for (const [id, event] of pending) {
      try {
        await client.record(event);
      } catch (error) {
        if (!(error instanceof MindseaHttpError) || error.status !== 409) throw error;
        const old = await client.event(id);
        if (
          old.sessionId !== event.sessionId ||
          old.role !== event.role ||
          old.content !== event.content
        )
          throw error;
        // The pre-step may have recorded this immutable message before DSH committed its timestamp.
      }
      pending.delete(id);
    }
  };
  return {
    enqueue,
    capture,
    replay,
    flush,
    hasPending: () => pending.size > 0,
  };
}
export type EventBuffer = ReturnType<typeof createEventBuffer>;
