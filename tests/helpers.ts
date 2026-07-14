import { exports } from "cloudflare:workers";

import type { ApiEnvelope, CollectionSummary, NoteSummary } from "@shared/contracts";

export function queueSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

export async function workerFetch(path: string, init: RequestInit = {}, user = "admin@example.com") {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user-email", user);
  return exports.default.fetch(`https://knowledge.test${path}`, { ...init, headers });
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, user = "admin@example.com") {
  const response = await workerFetch(path, init, user);
  const body = await response.json() as ApiEnvelope<T> | { error: { code: string; message: string } };
  return { response, body };
}

export function jsonInit(method: string, value: unknown, headers?: HeadersInit): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(value),
  };
}

export async function createCollection(name = `Knowledge ${crypto.randomUUID().slice(0, 8)}`) {
  const { response, body } = await apiRequest<CollectionSummary>(
    "/api/v1/collections",
    jsonInit("POST", { name, description: "Integration test" }),
  );
  if (!response.ok || !("data" in body)) throw new Error(`Unable to create collection: ${response.status}`);
  return body.data;
}

export async function createNote(collectionId: string, options: { title?: string; tags?: string[]; body?: string } = {}) {
  const title = options.title ?? `Note ${crypto.randomUUID().slice(0, 8)}`;
  const markdown = `---\ntitle: ${JSON.stringify(title)}\ntags: ${JSON.stringify(options.tags ?? ["test"])}\nstatus: published\n---\n\n# ${title}\n\n${options.body ?? "测试正文"}\n`;
  const { response, body } = await apiRequest<NoteSummary & { jobId: string }>(
    `/api/v1/collections/${collectionId}/notes`,
    jsonInit("POST", { markdown }),
  );
  if (!response.ok || !("data" in body)) throw new Error(`Unable to create note: ${response.status}`);
  return { note: body.data, markdown };
}

export async function mcpRequest(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  return workerFetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}
