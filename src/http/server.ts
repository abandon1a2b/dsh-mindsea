import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError, z } from "zod";
import { AppError, userSchema } from "../contracts/common.ts";
import type { Store } from "../storage/sqlite/store.ts";
import type { MeiliSearch } from "../search/meilisearch.ts";
import { send, authorizeIO, body } from "./io.ts";
import { agendaRoutes } from "./routes/agenda.ts";
import { eventsRoutes } from "./routes/events.ts";
import { itemsRoutes } from "./routes/items.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { retrievalRoutes } from "./routes/retrieval.ts";
function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
export function createApp(
  store: Store,
  apiKey: string,
  search?: MeiliSearch,
  options: { legacyAccess?: boolean } = {},
) {
  if (apiKey.length < 24)
    throw new Error("MINDSEA_API_KEY must contain at least 24 characters");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method;
      if (method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }
      const supplied = request.headers.authorization ?? "";
      let user: string;
      if (
        options.legacyAccess &&
        timingSafeEqual(digest(supplied), digest(`Bearer ${apiKey}`))
      ) {
        user = userSchema.parse(request.headers["x-user-id"]);
      } else {
        if (!supplied.startsWith("Bearer ")) throw new AppError(401, "Unauthorized");
        const identity = store.access.authenticate(supplied.slice(7));
        authorizeIO(request, response, () => {
          store.access.authenticate(supplied.slice(7));
        });
        const claimed = request.headers["x-user-id"];
        if (claimed && claimed !== identity.brainId)
          throw new AppError(403, "Brain identity mismatch");
        if (
          request.headers["x-brain-id"] &&
          request.headers["x-brain-id"] !== identity.brainId
        )
          throw new AppError(403, "Brain identity mismatch");
        if (url.pathname === "/v1/me" && method === "GET") {
          send(response, 200, identity);
          return;
        }
        if (url.pathname === "/v1/session-binding" && method === "POST") {
          const data = z
            .object({ sessionId: z.string().min(1).max(200) })
            .strict()
            .parse(await body(request));
          send(response, 200, store.access.bind(identity, data.sessionId));
          return;
        }
        user = identity.namespace;
      }
      const path = url.pathname;
      const recall = (query: string, limit: number) =>
        search
          ? search.recall(store, user, query, limit)
          : Promise.resolve(store.recall(user, query, limit));
      const context = {
        request,
        response,
        method,
        url,
        path,
        user,
        store,
        search,
        recall,
      };
      for (const route of [
        memoryRoutes,
        agendaRoutes,
        eventsRoutes,
        itemsRoutes,
        retrievalRoutes,
      ]) {
        if (await route(context)) return;
      }
      throw new AppError(404, "Not found");
    } catch (error) {
      if (error instanceof ZodError)
        send(response, 400, { error: "Invalid input", issues: error.issues });
      else if (error instanceof AppError)
        send(response, error.status, { error: error.message });
      else if (error instanceof URIError)
        send(response, 400, { error: "Invalid path encoding" });
      else {
        console.error(
          "Request failed",
          error instanceof Error ? error.name : "Unknown error",
        );
        send(response, 500, { error: "Internal server error" });
      }
    }
  });
}
