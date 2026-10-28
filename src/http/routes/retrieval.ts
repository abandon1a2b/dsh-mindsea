import type { RouteContext } from "../route-context.ts";
import { body, send } from "../io.ts";
import { contextSchema, querySchema } from "../../contracts/retrieval.ts";
import { buildContext } from "../../application/assemble-context.ts";

export async function retrievalRoutes(context: RouteContext): Promise<boolean> {
  const { method, path, user, store, search, recall, request, response } = context;
  if (method === "POST" && path === "/v1/memory/recall") {
    const input = querySchema.parse(await body(request));
    const items = search
      ? await search.recall(store, user, input.query, input.limit, true)
      : store.recall(user, input.query, input.limit, true);
    send(response, 200, {
      items: items.map((item) => ({ ...item, verification: "legacy-unverified" })),
      hint: "Use /v1/memory/query for evidence-backed L1-L3.",
    });
    return true;
  }
  if (method === "POST" && path === "/v1/future/check") {
    const input = contextSchema.parse(await body(request));
    if (store.nextReconciliation(user)) {
      send(response, 200, { state: "pending", items: [], omitted: 0 });
      return true;
    }
    const groups = buildContext(
      {
        due: store.due(user, undefined, input.limit),
        openLoops: store.loops(user, input.limit),
        relevant: [],
      },
      input.maxChars,
    );
    const items = [...groups.candidates.due, ...groups.candidates.openLoops];
    send(response, 200, {
      state: items.length || groups.omitted ? "ready" : "empty",
      items,
      omitted: groups.omitted,
    });
    return true;
  }
  if (method === "POST" && path === "/v1/recall") {
    const input = querySchema.parse(await body(request));
    send(response, 200, { items: await recall(input.query, input.limit) });
    return true;
  }
  if (method === "GET" && path === "/v1/future/due") {
    const reconciliationPending = store.nextReconciliation(user) !== null;
    send(response, 200, {
      items: reconciliationPending ? [] : store.due(user),
      reconciliationPending,
    });
    return true;
  }
  if (method === "GET" && path === "/v1/loops") {
    const reconciliationPending = store.nextReconciliation(user) !== null;
    send(response, 200, {
      items: reconciliationPending ? [] : store.loops(user),
      reconciliationPending,
    });
    return true;
  }
  if (method === "POST" && path === "/v1/context") {
    const input = contextSchema.parse(await body(request));
    // Fetch relevant data first, then obtain current timeline state after any network await.
    const relevant = await recall(input.query, input.limit);
    const reconciliationPending = store.nextReconciliation(user) !== null;
    send(response, 200, {
      ...buildContext(
        {
          due: reconciliationPending ? [] : store.due(user, undefined, input.limit),
          openLoops: reconciliationPending ? [] : store.loops(user, input.limit),
          relevant: reconciliationPending
            ? relevant.filter((item) => item.kind === "memory")
            : relevant,
        },
        input.maxChars,
      ),
      reconciliationPending,
    });
    return true;
  }
  return false;
}
