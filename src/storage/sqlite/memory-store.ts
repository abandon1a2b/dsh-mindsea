import { MemoryTopics } from "./memory-topics.ts";
import type { DatabaseSync } from "node:sqlite";
import { MemoryRecords } from "./memory-records.ts";
import { MemoryJobs } from "./memory-jobs.ts";
import { MemoryLifecycle } from "./memory-lifecycle.ts";
import { MemoryRetrieval } from "./memory-retrieval.ts";

/** Shared transaction owner, with separate responsibilities for each memory capability. */
export class MemoryStore {
  topics: MemoryTopics;
  records: MemoryRecords;
  jobs: MemoryJobs;
  lifecycle: MemoryLifecycle;
  retrieval: MemoryRetrieval;
  constructor(db: DatabaseSync) {
    this.topics = new MemoryTopics(db);
    this.records = new MemoryRecords(db);
    this.jobs = new MemoryJobs(this.records);
    this.lifecycle = new MemoryLifecycle(this.records);
    this.retrieval = new MemoryRetrieval(this.records, this.jobs);
  }
}
