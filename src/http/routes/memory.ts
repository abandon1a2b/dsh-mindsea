import { z } from "zod";
import type { RouteContext } from "../route-context.ts";
import { atomic } from "../../storage/sqlite/transaction.ts";
import { evidenceSchema } from "../../contracts/memory.ts";
import { body, send } from "../io.ts";

export async function memoryRoutes(context: RouteContext): Promise<boolean> {
  const { method, path, user, request, response, url, store } = context;
  const memory = store.memory;
  if (method === "POST" && path === "/v1/memory/remember") {
    const input = z
      .object({ content: z.string().min(1).max(12000), evidence: evidenceSchema })
      .strict()
      .parse(await body(request));
    send(
      response,
      201,
      atomic(store.db, () =>
        memory.records.save(
          user,
          {
            layer: "L1",
            kind: "fact",
            subjectId: "self",
            scope: { kind: "global", key: "*" },
            topic: "explicit-memory",
            content: input.content,
            basis: "explicit",
            status: "active",
            evidence: [input.evidence],
            dependencies: [],
            validFrom: null,
            validTo: null,
            reviewAfter: null,
          },
          input.evidence.eventId,
          "explicit-tool",
        ),
      ),
    );
    return true;
  }
  if (method === "POST" && path === "/v1/memory/jobs/claim") {
    send(response, 200, { job: memory.jobs.claim(user) });
    return true;
  }
  if (method === "GET" && path === "/v1/memory/jobs") {
    send(response, 200, {
      jobs: memory.jobs.list(user),
      watermark: memory.jobs.watermark(user),
    });
    return true;
  }
  const job = path.match(/^\/v1\/memory\/jobs\/(\d+)\/(commit|fail|retry)$/);
  if (method === "POST" && job) {
    const id = z.coerce.number().int().positive().parse(job[1]);
    if (job[2] === "commit")
      send(response, 200, { items: memory.jobs.commit(user, id, await body(request)) });
    else if (job[2] === "fail") {
      const data = z
        .object({ token: z.string().min(1).max(200) })
        .strict()
        .parse(await body(request));
      memory.jobs.fail(user, id, data.token);
      send(response, 200, { ok: true });
    } else {
      memory.jobs.retry(user, id);
      send(response, 200, { ok: true });
    }
    return true;
  }
  if (method === "POST" && path === "/v1/memory/rebuild") {
    send(response, 200, { queued: memory.jobs.rebuild(user) });
    return true;
  }
  if (method === "POST" && path === "/v1/memory/query") {
    const input = await body(request);
    send(
      response,
      200,
      context.search
        ? await context.search.memory.recall(store, user, input)
        : memory.retrieval.recall(user, input),
    );
    return true;
  }
  if (method === "POST" && path === "/v1/memory/actions") {
    send(response, 200, memory.lifecycle.act(user, await body(request)));
    return true;
  }
  if (method === "POST" && path === "/v1/memory/forget") {
    send(response, 200, memory.lifecycle.forget(user, await body(request)));
    return true;
  }
  if (method === "GET" && path === "/v1/memory/topics") {
    send(response, 200, { topics: memory.topics.list(user) });
    return true;
  }
  if (method === "POST" && path === "/v1/memory/topics/alias") {
    send(response, 200, memory.topics.alias(user, await body(request)));
    return true;
  }
  const record = path.match(/^\/v1\/memory\/records\/([^/]+)(\/history)?$/);
  if (method === "GET" && record) {
    const id = decodeURIComponent(record[1]!);
    send(
      response,
      200,
      record[2] ? memory.records.history(user, id) : memory.records.get(user, id),
    );
    return true;
  }
  const evidence = path.match(/^\/v1\/memory\/evidence\/([^/]+)$/);
  if (method === "GET" && evidence) {
    const start = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(url.searchParams.get("start") ?? 0);
    const end = url.searchParams.has("end")
      ? z.coerce.number().int().positive().parse(url.searchParams.get("end"))
      : undefined;
    send(
      response,
      200,
      memory.records.evidence(user, decodeURIComponent(evidence[1]!), start, end),
    );
    return true;
  }
  return false;
}
