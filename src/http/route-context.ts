import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../storage/sqlite/store.ts";
import type { MeiliSearch } from "../search/meilisearch.ts";
import type { Item } from "../contracts/items.ts";
export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  method: string | undefined;
  url: URL;
  path: string;
  user: string;
  store: Store;
  search?: MeiliSearch;
  recall: (query: string, limit: number) => Promise<Item[]>;
}
