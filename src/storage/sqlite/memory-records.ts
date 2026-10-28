import { atomic } from "./transaction.ts";
import { resolveTopic } from "./memory-topics.ts";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../contracts/common.ts";
import {
  memoryInputSchema,
  type Evidence,
  type MemoryInput,
  type MemoryRecord,
  type MemoryStatus,
} from "../../contracts/memory.ts";
import type { Event } from "../../contracts/events.ts";

export class MemoryRecords {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  revision(user: string): number {
    return Number(
      this.db
        .prepare("SELECT revision FROM memory_user_revision WHERE user_id=?")
        .get(user)?.revision ?? 0,
    );
  }
  bump(user: string): void {
    this.db
      .prepare(
        "INSERT INTO memory_user_revision VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1",
      )
      .run(user);
  }
  event(user: string, id: string): Event {
    const row = this.db
      .prepare("SELECT document FROM events WHERE id=? AND user_id=?")
      .get(id, user);
    if (!row) throw new AppError(404, "Evidence event not found");
    return JSON.parse(row.document as string) as Event;
  }
  get(user: string, id: string): MemoryRecord {
    const row = this.db
      .prepare("SELECT document FROM memory_records WHERE id=? AND user_id=?")
      .get(id, user);
    if (!row) throw new AppError(404, "Memory not found");
    return JSON.parse(row.document as string) as MemoryRecord;
  }
  list(user: string): MemoryRecord[] {
    return this.db
      .prepare("SELECT document FROM memory_records WHERE user_id=? ORDER BY id")
      .all(user)
      .map((r) => JSON.parse(r.document as string) as MemoryRecord);
  }
  history(user: string, id: string): MemoryRecord[] {
    this.get(user, id);
    return this.db
      .prepare(
        "SELECT document FROM memory_revisions WHERE id=? AND user_id=? ORDER BY version",
      )
      .all(id, user)
      .map((r) => JSON.parse(r.document as string) as MemoryRecord);
  }
  validateEvidence(user: string, evidence: Evidence): Event {
    const event = this.event(user, evidence.eventId);
    if (event.role !== "user")
      throw new AppError(400, "User knowledge requires human evidence");
    const chars = [...event.content];
    if (evidence.start >= evidence.end || evidence.end > chars.length)
      throw new AppError(400, "Evidence offsets out of bounds");
    const hash = createHash("sha256")
      .update(chars.slice(evidence.start, evidence.end).join(""))
      .digest("hex");
    if (hash !== evidence.contentHash)
      throw new AppError(400, "Evidence hash mismatch");
    return event;
  }
  evidence(user: string, eventId: string, start = 0, end?: number): Evidence {
    const event = this.event(user, eventId);
    const chars = [...event.content];
    const stop = end ?? chars.length;
    const result: Evidence = {
      eventId,
      start,
      end: stop,
      contentHash: createHash("sha256")
        .update(chars.slice(start, stop).join(""))
        .digest("hex"),
      relation: "supports",
    };
    this.validateEvidence(user, result);
    return result;
  }
  persist(record: MemoryRecord): void {
    const document = JSON.stringify(record);
    this.db
      .prepare(
        "INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,topic=excluded.topic,content=excluded.content,version=excluded.version,document=excluded.document",
      )
      .run(
        record.id,
        record.userId,
        record.layer,
        record.status,
        record.topic,
        record.content,
        record.version,
        document,
      );
    this.db
      .prepare(
        "INSERT INTO memory_revisions(id,user_id,version,document) VALUES(?,?,?,?)",
      )
      .run(record.id, record.userId, record.version, document);
    this.db.prepare("DELETE FROM memory_dependencies WHERE id=?").run(record.id);
    for (const dep of record.dependencies)
      this.db
        .prepare("INSERT INTO memory_dependencies VALUES(?,?,?)")
        .run(record.id, dep.id, dep.version);
    this.db.prepare("DELETE FROM memory_evidence WHERE id=?").run(record.id);
    for (const evidence of record.evidence)
      this.db
        .prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?)")
        .run(record.id, evidence.eventId, evidence.relation, JSON.stringify(evidence));
    this.db
      .prepare("INSERT OR IGNORE INTO memory_topics VALUES(?,?)")
      .run(record.userId, record.topic);
    this.db
      .prepare(
        "INSERT INTO memory_outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
      )
      .run(record.id, record.version);
    this.bump(record.userId);
  }
  invalidate(
    user: string,
    id: string,
    status: MemoryStatus,
    triggerEventId: string,
    reason: string,
  ): void {
    return atomic(this.db, () =>
      this.invalidateWithinTransaction(user, id, status, triggerEventId, reason),
    );
  }
  private invalidateWithinTransaction(
    user: string,
    id: string,
    status: MemoryStatus,
    triggerEventId: string,
    reason: string,
  ): void {
    const queue = [id];
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const old = this.get(user, current);
      for (const row of this.db
        .prepare("SELECT id FROM memory_dependencies WHERE source_id=?")
        .all(current))
        queue.push(row.id as string);
      if (current === id && (status === "retracted" || status === "superseded")) {
        for (const root of old.rootEventIds)
          this.db
            .prepare("INSERT OR IGNORE INTO memory_blocked_sources VALUES(?,?,?)")
            .run(user, root, reason);
      }
      if (old.status === "retracted") continue;
      this.persist({
        ...old,
        status:
          current === id ? status : status === "retracted" ? "retracted" : "disputed",
        version: old.version + 1,
        updatedAt: new Date().toISOString(),
        triggerEventId,
        reason,
      });
    }
  }
  usable(
    user: string,
    record: MemoryRecord,
    at = new Date().toISOString(),
    seen = new Set<string>(),
  ): boolean {
    if (seen.has(record.id) || record.status !== "active") return false;
    seen.add(record.id);
    if (
      (record.validFrom && record.validFrom > at) ||
      (record.validTo && record.validTo <= at) ||
      (record.reviewAfter && record.reviewAfter <= at)
    )
      return false;
    if (
      record.rootEventIds.some((id) =>
        this.db
          .prepare(
            "SELECT 1 FROM memory_blocked_sources WHERE user_id=? AND event_id=?",
          )
          .get(user, id),
      )
    )
      return false;
    for (const ev of record.evidence) {
      try {
        this.validateEvidence(user, ev);
      } catch {
        return false;
      }
    }
    for (const dep of record.dependencies) {
      try {
        const current = this.get(user, dep.id);
        if (
          current.version !== dep.version ||
          !this.usable(user, current, at, new Set(seen))
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  save(
    user: string,
    input: MemoryInput,
    triggerId: string,
    extractorVersion: string,
    update?: { id: string; version: number },
  ): MemoryRecord {
    return atomic(this.db, () =>
      this.saveWithinTransaction(user, input, triggerId, extractorVersion, update),
    );
  }
  private saveWithinTransaction(
    user: string,
    input: MemoryInput,
    triggerId: string,
    extractorVersion: string,
    update?: { id: string; version: number },
  ): MemoryRecord {
    const data = memoryInputSchema.parse(input);
    data.topic = resolveTopic(this.db, user, data.topic);
    const trigger = this.event(user, triggerId);
    if (trigger.role !== "user")
      throw new AppError(400, "Memory changes require human evidence");
    const old = update ? this.get(user, update.id) : undefined;
    if (
      old &&
      (old.version !== update!.version ||
        old.layer !== data.layer ||
        old.subjectId !== data.subjectId ||
        JSON.stringify(old.scope) !== JSON.stringify(data.scope))
    )
      throw new AppError(409, "Stale version or identity changed");
    if (old && old.status === "retracted")
      throw new AppError(409, "Retracted memory cannot be revived");
    if (old && this.event(user, old.triggerEventId).occurredAt > trigger.occurredAt)
      throw new AppError(409, "Older evidence cannot overwrite newer knowledge");
    const evidence = [...data.evidence];
    for (const ev of evidence) {
      this.validateEvidence(user, ev);
      if (
        ev.relation === "supports" &&
        this.db
          .prepare(
            "SELECT 1 FROM memory_blocked_sources WHERE user_id=? AND event_id=?",
          )
          .get(user, ev.eventId)
      )
        throw new AppError(
          409,
          "Source was superseded or retracted; fresh evidence is required",
        );
    }
    const dependencies = data.dependencies.map((ref) => {
      const source = this.get(user, ref.id);
      if (source.version !== ref.version || !this.usable(user, source))
        throw new AppError(409, "Stale or inactive dependency");
      if (source.layer >= data.layer || source.subjectId !== data.subjectId)
        throw new AppError(400, "Invalid dependency hierarchy or subject");
      if (data.layer === "L2" && source.layer !== "L1")
        throw new AppError(400, "L2 requires L1 facts");
      if (data.layer === "L3") {
        const scopeQueue = [source];
        const seen = new Set<string>();
        while (scopeQueue.length) {
          const ancestor = scopeQueue.shift()!;
          if (seen.has(ancestor.id)) continue;
          seen.add(ancestor.id);
          if (
            ancestor.scope.kind !== "global" &&
            JSON.stringify(ancestor.scope) !== JSON.stringify(data.scope)
          )
            throw new AppError(400, "Profile cannot broaden the scope of its evidence");
          for (const dependency of ancestor.dependencies)
            scopeQueue.push(this.get(user, dependency.id));
        }
      }
      evidence.push(...source.evidence);
      return ref;
    });
    const unique = [...new Map(evidence.map((e) => [JSON.stringify(e), e])).values()];
    const roots = [
      ...new Set(unique.filter((e) => e.relation === "supports").map((e) => e.eventId)),
    ];
    if (!roots.length) throw new AppError(400, "Memory requires supporting evidence");
    if (data.layer === "L1" && !unique.some((e) => e.eventId === triggerId))
      throw new AppError(400, "L1 must cite its trigger event");
    if (
      data.layer === "L3" &&
      data.basis === "explicit" &&
      !unique.some((e) => e.eventId === triggerId && e.relation === "supports")
    )
      throw new AppError(400, "Explicit profile must cite current statement");
    if (data.layer === "L3" && data.confirmation) {
      if (data.confirmation.relation !== "supports")
        throw new AppError(400, "Confirmation must support the claim");
      if (
        data.basis === "inferred" &&
        (!old ||
          old.layer !== "L3" ||
          old.status !== "candidate" ||
          old.rootEventIds.includes(triggerId))
      )
        throw new AppError(
          400,
          "An inferred candidate requires a separate new confirmation",
        );
      this.validateEvidence(user, data.confirmation);
      if (data.confirmation.eventId !== triggerId)
        throw new AppError(400, "Confirmation must be current evidence");
      unique.push(data.confirmation);
      if (!roots.includes(data.confirmation.eventId))
        roots.push(data.confirmation.eventId);
    }
    const status =
      data.layer === "L3" && data.basis === "inferred" && !data.confirmation
        ? "candidate"
        : data.status;
    if (!old) {
      const duplicate = this.list(user).find(
        (record) =>
          record.status === status &&
          record.layer === data.layer &&
          record.subjectId === data.subjectId &&
          record.topic === data.topic &&
          record.content === data.content &&
          JSON.stringify(record.scope) === JSON.stringify(data.scope) &&
          record.basis === data.basis &&
          record.validFrom === data.validFrom &&
          record.validTo === data.validTo &&
          record.reviewAfter === data.reviewAfter &&
          JSON.stringify("claim" in record ? record.claim : null) ===
            JSON.stringify("claim" in data ? data.claim : null) &&
          JSON.stringify(record.dependencies) === JSON.stringify(dependencies) &&
          JSON.stringify(record.rootEventIds.slice().sort()) ===
            JSON.stringify(roots.slice().sort()),
      );
      if (duplicate) return duplicate;
    }
    if (old) {
      for (const row of this.db
        .prepare("SELECT id FROM memory_dependencies WHERE source_id=?")
        .all(old.id))
        this.invalidate(
          user,
          row.id as string,
          "disputed",
          triggerId,
          "Dependency revised",
        );
    }
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      ...data,
      dependencies,
      evidence: unique,
      id: old?.id ?? randomUUID(),
      userId: user,
      version: (old?.version ?? 0) + 1,
      status,
      rootEventIds: roots,
      independentEvidenceCount: new Set(
        roots.map((id) =>
          createHash("sha256").update(this.event(user, id).content).digest("hex"),
        ),
      ).size,
      recordedAt: old?.recordedAt ?? now,
      updatedAt: now,
      policyVersion: "memory-v1",
      extractorVersion,
      revisionSet: this.revision(user),
      triggerEventId: triggerId,
      reason: "Evidence-based update",
    };
    // A competing active claim in the exact same scope is not silently overwritten.
    if (record.layer === "L3" && status === "active")
      for (const peer of this.list(user)) {
        if (
          peer.id !== record.id &&
          peer.layer === "L3" &&
          peer.status === "active" &&
          peer.subjectId === record.subjectId &&
          JSON.stringify(peer.scope) === JSON.stringify(record.scope) &&
          peer.claim.predicate === record.claim.predicate &&
          peer.claim.value !== record.claim.value
        ) {
          this.invalidate(
            user,
            peer.id,
            "disputed",
            triggerId,
            "Conflicting claim needs resolution",
          );
          record.status = "disputed";
        }
      }
    this.persist(record);
    return record;
  }
}
