import type { Event } from "../contracts/events.ts";
import type { Item, ItemInput } from "../contracts/items.ts";
import type {
  ReconciliationJob,
  ReconciliationPlan,
  AgendaPage,
  FutureCheck,
} from "../contracts/agenda.ts";
import type { ContextResponse } from "../contracts/retrieval.ts";

export class MindseaHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Server-side adapter only: never expose the shared service key to end users. */
export class MindseaClient {
  baseUrl: string;
  apiKey: string;
  userId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  constructor(options: {
    baseUrl: string;
    apiKey: string;
    userId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }
  private async request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "X-User-ID": this.userId,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.any([
        AbortSignal.timeout(this.timeoutMs),
        ...(this.signal ? [this.signal] : []),
      ]),
    });
    if (!response.ok)
      throw new MindseaHttpError(
        response.status,
        `Mindsea service HTTP ${response.status}: ${await response.text()}`,
      );
    return response.json() as Promise<T>;
  }
  record(input: {
    id?: string;
    sessionId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    occurredAt?: string;
  }) {
    return this.request<Event>("/v1/events", "POST", input);
  }
  event(id: string) {
    return this.request<Event>(`/v1/events/${encodeURIComponent(id)}`);
  }
  remember(item: ItemInput) {
    return this.request<Item>("/v1/items", "POST", item);
  }
  update(id: string, version: number, item: ItemInput) {
    return this.request<Item>(`/v1/items/${encodeURIComponent(id)}`, "PUT", {
      version,
      item,
    });
  }
  get(id: string) {
    return this.request<Item>(`/v1/items/${encodeURIComponent(id)}`);
  }
  history(id: string) {
    return this.request<Item[]>(`/v1/items/${encodeURIComponent(id)}/history`);
  }
  memoryRecall(query: string, limit = 10) {
    return this.request<{ items: Item[] }>("/v1/memory/recall", "POST", {
      query,
      limit,
    });
  }
  futureCheck(limit = 5, maxChars = 6000) {
    return this.request<FutureCheck>("/v1/future/check", "POST", {
      limit,
      maxChars,
    });
  }
  recall(query: string, limit = 10) {
    return this.request<{ items: Item[] }>("/v1/recall", "POST", {
      query,
      limit,
    });
  }
  context(query: string, maxChars = 12_000) {
    return this.request<ContextResponse>("/v1/context", "POST", {
      query,
      maxChars,
    });
  }
  nextReconciliation() {
    return this.request<{ job: ReconciliationJob | null }>("/v1/reconciliation/next");
  }
  agenda(after = "", limit = 100) {
    return this.request<AgendaPage>(
      `/v1/agenda?after=${encodeURIComponent(after)}&limit=${limit}`,
    );
  }
  reconcile(eventId: string, plan: ReconciliationPlan) {
    return this.request<{ items: Item[] }>(
      `/v1/reconciliation/${encodeURIComponent(eventId)}`,
      "POST",
      plan,
    );
  }
  due() {
    return this.request<{ items: Item[]; reconciliationPending: boolean }>(
      "/v1/future/due",
    );
  }
  loops() {
    return this.request<{ items: Item[]; reconciliationPending: boolean }>("/v1/loops");
  }
}
