import { randomUUID } from "node:crypto";
import { AppError } from "../../contracts/common.ts";
import {
  commitMemorySchema,
  type MemoryJob,
  type MemoryRecord,
  type MemoryWatermark,
} from "../../contracts/memory.ts";
import type { Event } from "../../contracts/events.ts";
import { MemoryRecords } from "./memory-records.ts";
import { atomic } from "./transaction.ts";

export class MemoryJobs {
  records: MemoryRecords;
  constructor(records: MemoryRecords) {
    this.records = records;
  }
  watermark(user: string): MemoryWatermark {
    const db = this.records.db;
    const count = (status: string) =>
      Number(
        db
          .prepare("SELECT count(*) n FROM memory_jobs WHERE user_id=? AND status=?")
          .get(user, status)!.n,
      );
    return {
      pending: count("pending") + count("running"),
      failed: count("failed"),
      lastCompletedEventId:
        (db
          .prepare(
            "SELECT event_id FROM memory_jobs WHERE user_id=? AND status='done' ORDER BY id DESC LIMIT 1",
          )
          .get(user)?.event_id as string | undefined) ?? null,
      revision: this.records.revision(user),
    };
  }
  claim(user: string, now = new Date().toISOString()): MemoryJob | null {
    const db = this.records.db;
    return atomic(db, () => {
      db.prepare(
        "UPDATE memory_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,token=NULL,lease_until=NULL,error='Lease expired' WHERE user_id=? AND status='running' AND lease_until<=?",
      ).run(user, now);
      if (
        db
          .prepare("SELECT 1 FROM memory_jobs WHERE user_id=? AND status='running'")
          .get(user)
      )
        return null;
      const row = db
        .prepare(
          "SELECT id,event_id,policy FROM memory_jobs WHERE user_id=? AND status='pending' AND available_at<=? ORDER BY id LIMIT 1",
        )
        .get(user, now);
      if (!row) return null;
      const records = db
        .prepare(
          "SELECT document FROM memory_records WHERE user_id=? AND status NOT IN ('retracted','superseded') ORDER BY id LIMIT 2001",
        )
        .all(user)
        .map((row) => JSON.parse(row.document as string) as MemoryRecord);
      if (records.length > 2000) {
        db.prepare(
          "UPDATE memory_jobs SET status='failed',error='Memory snapshot exceeds worker capacity' WHERE id=?",
        ).run(row.id!);
        return null;
      }
      const token = randomUUID();
      const leaseUntil = new Date(new Date(now).getTime() + 120000).toISOString();
      db.prepare(
        "UPDATE memory_jobs SET status='running',attempts=attempts+1,token=?,lease_until=? WHERE id=?",
      ).run(token, leaseUntil, row.id!);
      const event = this.records.event(user, row.event_id as string);
      const recentEvents = db
        .prepare(
          "SELECT document FROM events WHERE user_id=? AND json_extract(document,'$.sessionId')=? AND rowid<(SELECT rowid FROM events WHERE id=?) ORDER BY rowid DESC LIMIT 20",
        )
        .all(user, event.sessionId, event.id)
        .map((r) => JSON.parse(r.document as string) as Event)
        .reverse();
      return {
        id: Number(row.id),
        event,
        recentEvents,
        records,
        revision: this.records.revision(user),
        token,
        leaseUntil,
        policyVersion: row.policy as string,
      };
    });
  }
  commit(user: string, id: number, input: unknown): MemoryRecord[] {
    const data = commitMemorySchema.parse(input);
    const db = this.records.db;
    return atomic(db, () => {
      const job = db
        .prepare("SELECT * FROM memory_jobs WHERE id=? AND user_id=?")
        .get(id, user);
      if (!job) throw new AppError(404, "Job not found");
      if (job.status === "done" && job.token === data.token)
        return JSON.parse(job.result as string) as MemoryRecord[];
      if (
        job.status !== "running" ||
        job.token !== data.token ||
        String(job.lease_until) <= new Date().toISOString()
      )
        throw new AppError(409, "Job lease expired");
      if (data.revision !== this.records.revision(user))
        throw new AppError(409, "Memory changed; retry with a fresh snapshot");
      const eventId = job.event_id as string;
      for (const change of data.plan.invalidations) {
        if (change.evidence.eventId !== eventId)
          throw new AppError(400, "Correction needs current event");
        const ev = this.records.validateEvidence(user, change.evidence);
        const old = this.records.get(user, change.target.id);
        if (old.version !== change.target.version)
          throw new AppError(409, "Stale correction target");
        if (this.records.event(user, old.triggerEventId).occurredAt > ev.occurredAt)
          throw new AppError(
            409,
            "Historical correction cannot supersede current knowledge",
          );
        this.records.invalidate(user, old.id, change.status, eventId, change.reason);
      }
      const local = new Map<string, MemoryRecord>();
      const results: MemoryRecord[] = [];
      for (const write of data.plan.writes) {
        const record = {
          ...write.record,
          dependencies: write.record.dependencies.map((ref) => {
            if (!ref.id.startsWith("$")) return ref;
            const found = local.get(ref.id.slice(1));
            if (!found) throw new AppError(400, "Unresolved local dependency");
            return { id: found.id, version: found.version };
          }),
        };
        const saved = this.records.save(
          user,
          record,
          eventId,
          data.plan.extractorVersion,
          write.id ? { id: write.id, version: write.version! } : undefined,
        );
        local.set(write.key, saved);
        results.push(saved);
      }
      db.prepare(
        "UPDATE memory_jobs SET status='done',lease_until=NULL,result=?,error=NULL WHERE id=?",
      ).run(JSON.stringify(results), id);
      return results;
    });
  }
  fail(user: string, id: number, token: string): void {
    const result = this.records.db
      .prepare(
        "UPDATE memory_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,available_at=?,token=NULL,lease_until=NULL,error='Processing failed' WHERE id=? AND user_id=? AND status='running' AND token=? AND lease_until>?",
      )
      .run(
        new Date(Date.now() + 5000).toISOString(),
        id,
        user,
        token,
        new Date().toISOString(),
      );
    if (!result.changes) throw new AppError(409, "Job lease not owned");
  }
  retry(user: string, id: number): void {
    if (
      !this.records.db
        .prepare(
          "UPDATE memory_jobs SET status='pending',attempts=0,available_at='',token=NULL,error=NULL WHERE id=? AND user_id=? AND status='failed'",
        )
        .run(id, user).changes
    )
      throw new AppError(409, "Job is not failed");
  }
  list(user: string) {
    return this.records.db
      .prepare(
        "SELECT id,event_id AS eventId,status,attempts,available_at AS availableAt,error FROM memory_jobs WHERE user_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(user);
  }
  rebuild(user: string): number {
    return atomic(this.records.db, () => {
      // Re-run non-forgotten events; current record versions and manual retractions still apply.
      const result = this.records.db
        .prepare(
          "INSERT OR IGNORE INTO memory_jobs(user_id,event_id,policy) SELECT user_id,id,? FROM events WHERE user_id=? AND json_extract(document,'$.role')='user' AND NOT EXISTS(SELECT 1 FROM memory_blocked_sources b WHERE b.user_id=events.user_id AND b.event_id=events.id)",
        )
        .run(`memory-v1:rebuild:${randomUUID()}`, user);
      return Number(result.changes);
    });
  }
}
