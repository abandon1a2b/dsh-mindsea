import type { RouteContext } from "../route-context.ts";
import { body, send } from "../io.ts";
import { z } from "zod";

export async function agendaRoutes(context: RouteContext): Promise<boolean> {
  const { method, path, url, user, store, request, response } = context;
  if (method === "GET" && path === "/v1/reconciliation/next") {
    send(response, 200, { job: store.nextReconciliation(user) });
    return true;
  }
  if (method === "GET" && path === "/v1/agenda") {
    const after = z
      .string()
      .max(200)
      .parse(url.searchParams.get("after") ?? "");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(url.searchParams.get("limit") ?? 100);
    send(response, 200, store.agenda(user, after, limit));
    return true;
  }
  const reconciliationMatch = path.match(/^\/v1\/reconciliation\/([^/]+)$/);
  if (method === "POST" && reconciliationMatch) {
    send(response, 200, {
      items: store.reconcile(
        user,
        decodeURIComponent(reconciliationMatch[1]!),
        await body(request),
      ),
    });
    return true;
  }
  return false;
}
