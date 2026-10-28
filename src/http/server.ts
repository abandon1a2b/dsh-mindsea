import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { AppError, userSchema } from "../contracts/common.ts";
import type { Store } from "../storage/sqlite/store.ts";
import type { MeiliSearch } from "../search/meilisearch.ts";
import { send } from "./io.ts";
import { agendaRoutes } from "./routes/agenda.ts";
import { eventsRoutes } from "./routes/events.ts";
import { itemsRoutes } from "./routes/items.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { retrievalRoutes } from "./routes/retrieval.ts";
function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
export function createApp(store: Store, apiKey: string, search?: MeiliSearch) {
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
      if (!timingSafeEqual(digest(supplied), digest(`Bearer ${apiKey}`)))
        throw new AppError(401, "Unauthorized");
      const user = userSchema.parse(request.headers["x-user-id"]);
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
