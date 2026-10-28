import type { RouteContext } from "../route-context.ts";
import { body, send } from "../io.ts";
import { z } from "zod";
import { itemSchema } from "../../contracts/items.ts";

export async function itemsRoutes(context: RouteContext): Promise<boolean> {
  const { method, path, user, store, request, response } = context;
  if (method === "POST" && path === "/v1/items") {
    send(response, 201, store.save(user, await body(request)));
    return true;
  }
  const match = path.match(/^\/v1\/items\/([^/]+)(\/history)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    if (method === "GET") {
      send(response, 200, match[2] ? store.history(user, id) : store.get(user, id));
      return true;
    }
    if (method === "PUT" && !match[2]) {
      const input = z
        .object({ version: z.number().int().positive(), item: itemSchema })
        .strict()
        .parse(await body(request));
      send(response, 200, store.save(user, input.item, { id, version: input.version }));
      return true;
    }
  }
  return false;
}
