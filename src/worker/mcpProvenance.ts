import { z, ZodError } from "zod";

import type { Env, McpPrincipal } from "./env";
import { ApiError } from "./lib/errors";
import { isKnowledgeAdmin } from "./lib/principal";
import { handleVersionAwareMcpRequest } from "./mcpVersioning";
import { listReviewDueForMcp } from "./services/review";
import { recordAdminFailure, recordAdminUsage } from "./services/tokenRisk";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const listReviewDueInput = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

const reviewDueTool = {
  name: "list_review_due",
  title: "List knowledge due for review",
  description: "List published knowledge whose review_after deadline has passed. Returned items always include a review_due warning.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

function jsonRpcResponse(id: JsonRpcRequest["id"], result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function toolError(error: ApiError) {
  const value = { error: { code: error.code, message: error.message, details: error.details } };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function invalidParams(id: JsonRpcRequest["id"], error: ZodError) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32602, message: "Invalid params", data: error.flatten() },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requireReadScope(principal: McpPrincipal) {
  if (!principal.scopes.includes("knowledge:read") && !isKnowledgeAdmin(principal)) {
    throw new ApiError(403, "scope_required", "Token 缺少 knowledge:read 权限");
  }
}

async function delegateWithBody(request: Request, body: string, env: Env, principal: McpPrincipal) {
  return handleVersionAwareMcpRequest(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  }), env, principal);
}

async function mergeToolList(response: Response): Promise<Response> {
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  let payload: { result?: { tools?: unknown[] } };
  try {
    payload = await response.clone().json() as { result?: { tools?: unknown[] } };
  } catch {
    return response;
  }
  if (!Array.isArray(payload.result?.tools)) return response;
  payload.result.tools.push(reviewDueTool);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export async function handleProvenanceAwareMcpRequest(request: Request, env: Env, principal: McpPrincipal): Promise<Response> {
  if (request.method !== "POST") return handleVersionAwareMcpRequest(request, env, principal);
  const body = await request.text();
  let message: JsonRpcRequest;
  try {
    const parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") {
      return delegateWithBody(request, body, env, principal);
    }
    message = parsed;
  } catch {
    return delegateWithBody(request, body, env, principal);
  }

  if (message.method === "tools/list") {
    return mergeToolList(await delegateWithBody(request, body, env, principal));
  }
  if (message.method !== "tools/call") {
    return delegateWithBody(request, body, env, principal);
  }

  const name = typeof message.params?.name === "string" ? message.params.name : "";
  if (name !== "list_review_due") return delegateWithBody(request, body, env, principal);

  try {
    requireReadScope(principal);
    const input = listReviewDueInput.parse(message.params?.arguments ?? {});
    const result = await listReviewDueForMcp(env, principal, input.limit ?? 100);
    if (isKnowledgeAdmin(principal)) await recordAdminUsage(env, principal, "read");
    return jsonRpcResponse(message.id, toolResult(result));
  } catch (error) {
    if (error instanceof ZodError) return invalidParams(message.id, error);
    if (isKnowledgeAdmin(principal)) await recordAdminFailure(env, principal).catch(() => undefined);
    if (error instanceof ApiError) return jsonRpcResponse(message.id, toolError(error));
    throw error;
  }
}
