import { MemoryStore } from "./memory-store.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { initializeSchema } from "./schema.ts";
import { AppError, userSchema } from "../../contracts/common.ts";
import { eventSchema, type Event } from "../../contracts/events.ts";
import { itemSchema, type Item } from "../../contracts/items.ts";
import {
  reconciliationSchema,
  type ReconciliationJob,
  type AgendaPage,
} from "../../contracts/agenda.ts";

type Row = Record<string, unknown>;
function decode<T>(row: Row | undefined): T {
  if (!row) throw new AppError(404, "Not found");
  return JSON.parse(row.document as string) as T;
}
export class Store {
  db: DatabaseSync;
  memory: MemoryStore;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      initializeSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.memory = new MemoryStore(this.db);
  }

  close() {
    this.db.close();
  }
  event(user: string, id: string): Event {
    return decode(
      this.db
        .prepare("SELECT document FROM events WHERE id=? AND user_id=?")
        .get(id, user),
    );
  }
  addEvent(user: string, input: unknown): Event {
    userSchema.parse(user);
    const data = eventSchema.parse(input);
    const id = data.id ?? randomUUID();
    const hash = createHash("sha256").update(data.content).digest("hex");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM event_tombstones WHERE user_id=? AND (event_id=? OR content_hash=?)",
        )
        .get(user, id, hash)
    )
      throw new AppError(410, "Event has been forgotten");
    const existing = this.db.prepare("SELECT document FROM events WHERE id=?").get(id);
    if (existing) {
      const old = decode<Event>(existing);
      if (
        old.userId !== user ||
        old.sessionId !== data.sessionId ||
        old.role !== data.role ||
        old.content !== data.content ||
        (data.occurredAt && old.occurredAt !== data.occurredAt)
      )
        throw new AppError(409, "Event id already used");
      return old;
    }
    const result: Event = {
      ...data,
      id,
      userId: user,
      occurredAt: data.occurredAt ?? new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      producer: data.producer ?? "api",
      sourceKind: data.role === "user" ? "human" : data.role,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?)")
        .run(id, user, JSON.stringify(result));
      this.db
        .prepare("INSERT INTO reconciliation_jobs(event_id,user_id) VALUES(?,?)")
        .run(id, user);
      if (data.role === "user")
        this.db
          .prepare(
            "INSERT OR IGNORE INTO memory_jobs(user_id,event_id,policy) VALUES(?,?,'memory-v1')",
          )
          .run(user, id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(user: string, id: string): Item {
    return decode(
      this.db
        .prepare("SELECT document FROM items WHERE id=? AND user_id=?")
        .get(id, user),
    );
  }
  save(user: string, input: unknown, update?: { id: string; version: number }): Item {
    userSchema.parse(user);
    const data = itemSchema.parse(input);
    this.db.exec("SAVEPOINT save_item");
    try {
      const old = update ? this.get(user, update.id) : undefined;
      if (old && (old.version !== update!.version || old.kind !== data.kind))
        throw new AppError(409, "Stale version or kind change");
      if (data.sourceEventId) this.event(user, data.sourceEventId);
      const now = new Date().toISOString();
      const item: Item = {
        ...data,
        id: old?.id ?? randomUUID(),
        userId: user,
        status: data.status ?? (data.kind === "memory" ? "active" : "pending"),
        version: (old?.version ?? 0) + 1,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      const document = JSON.stringify(item);
      this.db
        .prepare(
          `INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,content=excluded.content,follow_up_at=excluded.follow_up_at,updated_at=excluded.updated_at,version=excluded.version,document=excluded.document`,
        )
        .run(
          item.id,
          user,
          item.kind,
          item.status,
          item.content,
          item.followUpAt ?? null,
          now,
          item.version,
          document,
        );
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?)")
        .run(item.id, item.version, document);
      this.db
        .prepare(
          "INSERT INTO outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
        )
        .run(item.id, item.version);
      this.db.exec("RELEASE save_item");
      return item;
    } catch (error) {
      this.db.exec("ROLLBACK TO save_item");
      this.db.exec("RELEASE save_item");
      throw error;
    }
  }
  agendaRevision(user: string): number {
    return this.db
      .prepare(
        `SELECT coalesce(max(revisions.rowid),0) AS revision
      FROM revisions JOIN items ON items.id=revisions.item_id
      WHERE items.user_id=? AND items.kind IN ('future','loop')`,
      )
      .get(user)!.revision as number;
  }
  nextReconciliation(user: string): ReconciliationJob | null {
    const job = this.db
      .prepare(
        `SELECT event_id FROM reconciliation_jobs
      WHERE user_id=? AND result IS NULL ORDER BY seq LIMIT 1`,
      )
      .get(user);
    if (!job) return null;
    const event = this.event(user, job.event_id as string);
    // Only preceding events from this session; later messages have their own ordered jobs.
    const recentEvents = this.db
      .prepare(
        `SELECT document FROM events
      WHERE user_id=? AND json_extract(document,'$.sessionId')=?
      AND rowid < (SELECT rowid FROM events WHERE id=?) ORDER BY rowid DESC LIMIT 20`,
      )
      .all(user, event.sessionId, event.id)
      .map((row) => decode<Event>(row))
      .reverse();
    return { event, recentEvents, agendaRevision: this.agendaRevision(user) };
  }
  agenda(user: string, after = "", limit = 100): AgendaPage {
    // No due/status/query filter: cancelled, completed and unmentioned plans can also be corrected.
    const rows = this.db
      .prepare(
        `SELECT document FROM items
      WHERE user_id=? AND kind IN ('future','loop') AND id>? ORDER BY id LIMIT ?`,
      )
      .all(user, after, limit + 1)
      .map((row) => decode<Item>(row));
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items.at(-1)!.id : null,
      agendaRevision: this.agendaRevision(user),
    };
  }
  reconcile(user: string, eventId: string, input: unknown): Item[] {
    const plan = reconciliationSchema.parse(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db
        .prepare(
          "SELECT seq,result FROM reconciliation_jobs WHERE event_id=? AND user_id=?",
        )
        .get(eventId, user);
      if (!job) throw new AppError(404, "Reconciliation job not found");
      // A delivered result may be retried after a network failure; never apply it twice.
      if (job.result !== null) {
        this.db.exec("COMMIT");
        return JSON.parse(job.result as string) as Item[];
      }
      const first = this.db
        .prepare(
          "SELECT event_id FROM reconciliation_jobs WHERE user_id=? AND result IS NULL ORDER BY seq LIMIT 1",
        )
        .get(user)!;
      if (first.event_id !== eventId)
        throw new AppError(409, "Process earlier events first");
      if (plan.agendaRevision !== this.agendaRevision(user))
        throw new AppError(409, "Agenda changed; re-read and reconcile");
      const evidence = this.event(user, eventId);
      // Enforce source authority at the service boundary, not only in a DSH prompt.
      if (evidence.role === "assistant") {
        if (plan.creates.length)
          throw new AppError(400, "Assistant evidence cannot create plans");
        for (const update of plan.updates) {
          const old = this.get(user, update.id);
          if (
            old.status !== "pending" ||
            update.item.status !== "followed_up" ||
            old.kind !== update.item.kind ||
            old.content !== update.item.content ||
            (old.followUpAt ?? null) !== (update.item.followUpAt ?? null)
          )
            throw new AppError(
              400,
              "Assistant evidence can only acknowledge a follow-up",
            );
        }
      }
      const results: Item[] = [];
      for (const update of plan.updates)
        results.push(
          this.save(
            user,
            { ...update.item, sourceEventId: eventId },
            { id: update.id, version: update.version },
          ),
        );
      for (const item of plan.creates)
        results.push(this.save(user, { ...item, sourceEventId: eventId }));
      this.db
        .prepare(
          "UPDATE reconciliation_jobs SET result=? WHERE event_id=? AND user_id=?",
        )
        .run(JSON.stringify(results), eventId, user);
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(user: string, id: string): Item[] {
    this.get(user, id);
    return this.db
      .prepare("SELECT document FROM revisions WHERE item_id=? ORDER BY version")
      .all(id)
      .map((row) => decode<Item>(row));
  }
  recall(user: string, query: string, limit = 10, memoryOnly = false): Item[] {
    const active = `user_id=? AND status IN ('active','pending','followed_up')${memoryOnly ? " AND kind='memory'" : ""}`;
    if (!query.trim())
      return this.db
        .prepare(
          `SELECT document FROM items WHERE ${active} ORDER BY updated_at DESC,id LIMIT ?`,
        )
        .all(user, limit)
        .map((row) => decode<Item>(row));
    if ([...query].length < 3)
      return this.db
        .prepare(
          `SELECT document FROM items WHERE ${active} AND instr(lower(content),lower(?))>0 ORDER BY updated_at DESC,id LIMIT ?`,
        )
        .all(user, query, limit)
        .map((row) => decode<Item>(row));
    const phrase = '"' + query.replaceAll('"', '""') + '"';
    return this.db
      .prepare(
        `SELECT items.document FROM search JOIN items ON items.id=search.id WHERE search MATCH ? AND items.user_id=? AND items.status IN ('active','pending','followed_up')${memoryOnly ? " AND items.kind='memory'" : ""} ORDER BY bm25(search),items.updated_at DESC LIMIT ?`,
      )
      .all(phrase, user, limit)
      .map((row) => decode<Item>(row));
  }
  due(user: string, now = new Date().toISOString(), limit = 10): Item[] {
    return this.db
      .prepare(
        `SELECT document FROM items WHERE user_id=? AND kind IN ('future','loop') AND status='pending' AND follow_up_at IS NOT NULL AND follow_up_at<=? ORDER BY follow_up_at,id LIMIT ?`,
      )
      .all(user, new Date(now).toISOString(), limit)
      .map((row) => decode<Item>(row));
  }
  loops(user: string, limit = 10): Item[] {
    return this.db
      .prepare(
        `SELECT document FROM items WHERE user_id=? AND kind='loop' AND status='pending' AND follow_up_at IS NULL ORDER BY updated_at DESC,id LIMIT ?`,
      )
      .all(user, limit)
      .map((row) => decode<Item>(row));
  }
  pending(limit = 100): Item[] {
    return this.db
      .prepare(
        "SELECT items.document FROM outbox JOIN items ON items.id=outbox.id LIMIT ?",
      )
      .all(limit)
      .map((row) => decode<Item>(row));
  }
  acknowledge(items: Item[]) {
    const statement = this.db.prepare("DELETE FROM outbox WHERE id=? AND version=?");
    for (const item of items) statement.run(item.id, item.version);
  }
  reindex() {
    this.db.exec(
      "INSERT INTO outbox SELECT id,version FROM items WHERE true ON CONFLICT(id) DO UPDATE SET version=excluded.version",
    );
  }
}
