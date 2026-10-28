import {
  memoryQuerySchema,
  type MemoryRecall,
  type MemoryRecord,
} from "../../contracts/memory.ts";
import { MemoryRecords } from "./memory-records.ts";
import { MemoryJobs } from "./memory-jobs.ts";

export class MemoryRetrieval {
  records: MemoryRecords;
  jobs: MemoryJobs;
  constructor(records: MemoryRecords, jobs: MemoryJobs) {
    this.records = records;
    this.jobs = jobs;
  }
  recall(user: string, input: unknown, candidateIds?: Set<string>): MemoryRecall {
    const query = memoryQuerySchema.parse(input);
    const watermark = this.jobs.watermark(user);
    const result: MemoryRecall = { items: [], quotes: [], omitted: 0, watermark };
    let remaining = query.maxChars;
    if (query.intent === "exact-quote") {
      const rows = this.records.db
        .prepare(
          "SELECT id FROM events WHERE user_id=? AND instr(lower(json_extract(document,'$.content')),lower(?))>0 AND (? IS NULL OR json_extract(document,'$.occurredAt')<=?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(user, query.query, query.asOf ?? null, query.asOf ?? null, query.limit);
      for (const row of rows) {
        const event = this.records.event(user, row.id as string);
        if (query.asOf && event.occurredAt > query.asOf) continue;
        const size = JSON.stringify(event).length;
        if (size > remaining) {
          result.omitted++;
          continue;
        }
        remaining -= size;
        result.quotes.push(event);
      }
      return result;
    }
    const at = query.asOf ?? new Date().toISOString();
    let candidates: MemoryRecord[];
    if (query.asOf) {
      candidates = this.records.db
        .prepare(
          `SELECT document FROM memory_revisions r WHERE user_id=? AND json_extract(document,'$.updatedAt')<=? AND version=(SELECT max(version) FROM memory_revisions v WHERE v.id=r.id AND json_extract(v.document,'$.updatedAt')<=?)`,
        )
        .all(user, at, at)
        .map((row) => JSON.parse(row.document as string) as MemoryRecord);
    } else candidates = this.records.list(user);
    const needle = query.query.toLocaleLowerCase();
    const scopeMatch = (record: MemoryRecord) =>
      record.scope.kind === "global" ||
      Boolean(
        query.scope &&
        record.scope.kind === query.scope.kind &&
        record.scope.key === query.scope.key,
      );
    candidates = candidates.filter((record) => {
      if (!query.layers.includes(record.layer) || !scopeMatch(record)) return false;
      const text = [
        record.content,
        record.topic,
        ...("claim" in record && record.claim
          ? [record.claim.predicate, record.claim.value]
          : []),
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (candidateIds && !candidateIds.has(record.id)) return false;
      if (!candidateIds && needle && !text.includes(needle)) return false;
      if (record.status === "retracted") return false;
      if (query.includeInactive) return true;
      if (query.asOf) {
        return (
          record.status === "active" &&
          (!record.validFrom || record.validFrom <= at) &&
          (!record.validTo || record.validTo > at) &&
          (!record.reviewAfter || record.reviewAfter > at) &&
          record.rootEventIds.every((id) => {
            try {
              this.records.event(user, id);
              return true;
            } catch {
              return false;
            }
          })
        );
      }
      return this.records.usable(user, record, at);
    });
    const order =
      query.intent === "history"
        ? ["L1", "L2", "L3"]
        : query.intent === "topic"
          ? ["L2", "L1", "L3"]
          : ["L3", "L2", "L1"];
    candidates.sort(
      (a, b) =>
        Number(b.scope.kind !== "global") - Number(a.scope.kind !== "global") ||
        order.indexOf(a.layer) - order.indexOf(b.layer) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    const seen = new Set<string>();
    const included = new Set<string>();
    for (const record of candidates) {
      const key =
        "claim" in record && record.claim
          ? `${record.subjectId}:${record.claim.predicate}`
          : `${record.subjectId}:${record.content}`;
      if (seen.has(key) || record.dependencies.some((ref) => included.has(ref.id)))
        continue;
      if (
        result.items.some((item) =>
          item.dependencies.some((ref) => ref.id === record.id),
        )
      )
        continue;
      if (
        result.items.some(
          (item) =>
            item.topic === record.topic &&
            item.subjectId === record.subjectId &&
            item.layer !== record.layer &&
            JSON.stringify(item.rootEventIds.slice().sort()) ===
              JSON.stringify(record.rootEventIds.slice().sort()),
        )
      )
        continue;
      const size = JSON.stringify(record).length;
      if (size > remaining || result.items.length >= query.limit) {
        result.omitted++;
        continue;
      }
      seen.add(key);
      included.add(record.id);
      remaining -= size;
      result.items.push(record);
    }
    return result;
  }
}
