import type { RouteContext } from "../route-context.ts";
import { body, send } from "../io.ts";

export async function eventsRoutes(context: RouteContext): Promise<boolean> {
  const { method, path, user, store, request, response } = context;
  if (method === "POST" && path === "/v1/events") {
    send(response, 201, store.addEvent(user, await body(request)));
    return true;
  }
  if (method === "GET" && /^\/v1\/events\/[^/]+$/.test(path)) {
    send(response, 200, store.event(user, decodeURIComponent(path.split("/")[3]!)));
    return true;
  }
  return false;
}
