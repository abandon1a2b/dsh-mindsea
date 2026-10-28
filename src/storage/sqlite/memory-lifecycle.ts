import { createHash } from "node:crypto";
import { AppError } from "../../contracts/common.ts";
import {
  forgetSchema,
  memoryActionSchema,
  type MemoryRecord,
} from "../../contracts/memory.ts";
import { MemoryRecords } from "./memory-records.ts";
import { atomic } from "./transaction.ts";

export class MemoryLifecycle {
  records: MemoryRecords;
  constructor(records: MemoryRecords) {
    this.records = records;
  }
  act(user: string, input: unknown): MemoryRecord {
    const action = memoryActionSchema.parse(input);
    return atomic(this.records.db, () => {
      if (action.revision !== this.records.revision(user))
        throw new AppError(409, "Stale memory snapshot");
      const record = this.records.get(user, action.target.id);
      if (record.version !== action.target.version)
        throw new AppError(409, "Stale memory version");
      const event = this.records.validateEvidence(user, action.evidence);
      if (this.records.event(user, record.triggerEventId).occurredAt > event.occurredAt)
        throw new AppError(
          409,
          "Confirmation or correction predates current knowledge",
        );
      if (action.action === "confirm") {
        if (
          record.layer !== "L3" ||
          record.status !== "candidate" ||
          action.evidence.relation !== "supports"
        )
          throw new AppError(400, "Only a supported L3 candidate can be confirmed");
        const {
          id: _,
          userId: _user,
          version: _version,
          recordedAt: _recorded,
          updatedAt: _updated,
          policyVersion: _policy,
          extractorVersion: _extractor,
          rootEventIds: _roots,
          independentEvidenceCount: _count,
          revisionSet: _revision,
          triggerEventId: _trigger,
          reason: _reason,
          ...inputRecord
        } = record;
        return this.records.save(
          user,
          {
            ...inputRecord,
            layer: "L3",
            status: "active",
            confirmation: action.evidence,
            evidence: [...record.evidence, action.evidence],
          },
          event.id,
          "user-confirmation",
          { id: record.id, version: record.version },
        );
      }
      this.records.invalidate(
        user,
        record.id,
        action.action === "retract" ? "retracted" : "disputed",
        event.id,
        action.reason,
      );
      return this.records.get(user, record.id);
    });
  }
  forget(
    user: string,
    input: unknown,
  ): { forgotten: number; affectedMemories: number } {
    const { eventIds } = forgetSchema.parse(input);
    const db = this.records.db;
    return atomic(db, () => {
      const ids = new Set(eventIds);
      const events = [...ids].map((id) => this.records.event(user, id));
      const hashes = new Set(
        events.map((event) => createHash("sha256").update(event.content).digest("hex")),
      );
      // Erase identical retained copies too; otherwise a second event can reconstitute the text.
      for (const row of db
        .prepare("SELECT id,document FROM events WHERE user_id=?")
        .all(user)) {
        const event = this.records.event(user, row.id as string);
        if (hashes.has(createHash("sha256").update(event.content).digest("hex")))
          ids.add(event.id);
      }
      const affected = new Set<string>();
      for (const record of this.records.list(user)) {
        if (
          this.records
            .history(user, record.id)
            .some(
              (version) =>
                version.rootEventIds.some((id) => ids.has(id)) ||
                (version.triggerEventId && ids.has(version.triggerEventId)),
            )
        )
          affected.add(record.id);
      }
      const queue = [...affected];
      while (queue.length) {
        for (const row of db
          .prepare("SELECT id FROM memory_dependencies WHERE source_id=?")
          .all(queue.shift()!)) {
          const id = row.id as string;
          if (!affected.has(id)) {
            affected.add(id);
            queue.push(id);
          }
        }
      }
      for (const id of affected) {
        const old = this.records.get(user, id);
        this.records.invalidate(
          user,
          id,
          "retracted",
          old.triggerEventId,
          "Evidence forgotten",
        );
      }
      // Redact every historical copy, not only the current projection.
      for (const id of affected) {
        const old = this.records.get(user, id);
        const sanitized = {
          ...old,
          content: "[forgotten]",
          topic: "forgotten",
          subjectId: "forgotten",
          scope: { kind: "global", key: "*" },
          evidence: [],
          dependencies: [],
          rootEventIds: [],
          independentEvidenceCount: 0,
          triggerEventId: "",
          reason: "Evidence forgotten",
          ...("claim" in old
            ? { claim: { predicate: "forgotten", value: "[forgotten]" } }
            : {}),
          ...("confirmation" in old ? { confirmation: undefined } : {}),
        };
        db.prepare(
          "UPDATE memory_records SET content='[forgotten]',topic='forgotten',document=? WHERE id=?",
        ).run(JSON.stringify(sanitized), id);
        db.prepare("DELETE FROM memory_revisions WHERE id=?").run(id);
        db.prepare(
          "INSERT INTO memory_revisions(id,user_id,version,document) VALUES(?,?,?,?)",
        ).run(id, user, sanitized.version, JSON.stringify(sanitized));
        db.prepare("DELETE FROM memory_evidence WHERE id=?").run(id);
        db.prepare("DELETE FROM memory_dependencies WHERE id=?").run(id);
      }
      for (const id of ids) {
        const event = this.records.event(user, id);
        db.prepare("INSERT OR IGNORE INTO event_tombstones VALUES(?,?,?)").run(
          user,
          id,
          createHash("sha256").update(event.content).digest("hex"),
        );
        // Legacy records and Future history can also retain the forgotten source text.
        const linked = db
          .prepare(
            "SELECT DISTINCT items.id FROM items JOIN revisions ON revisions.item_id=items.id WHERE items.user_id=? AND json_extract(revisions.document,'$.sourceEventId')=?",
          )
          .all(user, id);
        for (const row of linked) {
          const item = db
            .prepare("SELECT document,version FROM items WHERE id=?")
            .get(row.id!)!;
          const value = JSON.parse(item.document as string) as Record<string, unknown>;
          const version = Number(item.version) + 1;
          Object.assign(value, {
            content: "[forgotten]",
            status: "expired",
            sourceEventId: undefined,
            version,
            updatedAt: new Date().toISOString(),
          });
          db.prepare(
            "UPDATE items SET content='[forgotten]',status='expired',document=?,version=? WHERE id=?",
          ).run(JSON.stringify(value), version, row.id!);
          db.prepare("DELETE FROM revisions WHERE item_id=?").run(row.id!);
          db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(
            row.id!,
            version,
            JSON.stringify(value),
          );
          db.prepare(
            "INSERT INTO outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
          ).run(row.id!, version);
        }
        db.prepare(
          "DELETE FROM reconciliation_jobs WHERE event_id=? AND user_id=?",
        ).run(id, user);
        db.prepare("DELETE FROM memory_jobs WHERE event_id=? AND user_id=?").run(
          id,
          user,
        );
        db.prepare("DELETE FROM events WHERE id=? AND user_id=?").run(id, user);
      }
      // Completed batch receipts may contain copies of a forgotten record from any job.
      db.prepare(
        "UPDATE memory_jobs SET result='[]' WHERE user_id=? AND status='done'",
      ).run(user);
      db.prepare(
        "UPDATE reconciliation_jobs SET result='[]' WHERE user_id=? AND result IS NOT NULL",
      ).run(user);
      db.prepare("DELETE FROM memory_topics WHERE user_id=?").run(user);
      db.prepare(
        "INSERT OR IGNORE INTO memory_topics SELECT user_id,topic FROM memory_records WHERE user_id=? AND status<>'retracted'",
      ).run(user);
      for (const id of ids)
        db.prepare(
          "UPDATE memory_blocked_sources SET reason='Evidence forgotten' WHERE user_id=? AND event_id=?",
        ).run(user, id);
      db.prepare(
        "DELETE FROM memory_topic_aliases WHERE user_id=? AND topic NOT IN (SELECT topic FROM memory_topics WHERE user_id=?)",
      ).run(user, user);
      this.records.bump(user);
      return { forgotten: ids.size, affectedMemories: affected.size };
    });
  }
}
