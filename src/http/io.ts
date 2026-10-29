import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "../contracts/common.ts";
const guards = new WeakMap<object, () => void>();
export function authorizeIO(
  request: IncomingMessage,
  response: ServerResponse,
  guard: () => void,
) {
  guards.set(request, guard);
  guards.set(response, guard);
}
export async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw new AppError(413, "Request body too large");
    chunks.push(Buffer.from(chunk));
  }
  guards.get(request)?.();
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid JSON body");
  }
}
export function send(response: ServerResponse, status: number, value: unknown) {
  if (status < 400) guards.get(response)?.();
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
