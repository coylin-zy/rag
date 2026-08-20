import { z, ZodError } from "zod";

import type { Env, McpPrincipal } from "./env";
import { ApiError } from "./lib/errors";
import { isKnowledgeAdmin } from "./lib/principal";
import { handleMcpRequest } from "./mcp";
import { recordAdminFailure, recordAdminUsage, runAdminMutation } from "./services/tokenRisk";
import { listNoteVersions, readNoteVersion, restoreNoteVersion } from "./services/versionHistory";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const listVersionsInput = z.object({ note_id: z.string().uuid() });
const readVersionInput = z.object({
  note_id: z.string().uuid(),
  version: z.number().int().positive(),
});
const restoreVersionInput = z.object({
  operation_id: z.string().uuid(),
  note_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  source_version: z.number().int().positive(),
});

const versionTools = [
  {
    name: "list_note_versions",
    title: "List note versions",
    description: "List immutable historical versions for an authorized Markdown note.",
    inputSchema: {
      type: "object",
      properties: { note_id: { type: "string", format: "uuid" } },
      required: ["note_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_note_version",
    title: "Read note version",
    description: "Read the complete immutable Markdown for one historical version of an authorized note.",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", format: "uuid" },
        version: { type: "integer", minimum: 1 },
      },
      required: ["note_id", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

const restoreVersionTool = {
  name: "restore_note_version",
  title: "Restore note version",
  description: "Restore one historical Markdown version as a new current version. Requires the last observed current version and an idempotent operation_id.",
  inputSchema: {
    type: "object",
    properties: {
      operation_id: { type: "string", format: "uuid" },
      note_id: { type: "string", format: "uuid" },
      expected_version: { type: "integer", minimum: 1 },
      source_version: { type: "integer", minimum: 1 },
    },
    required: ["operation_id", "note_id", "expected_version", "source_version"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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

async function trackedRead<T>(env: Env, principal: McpPrincipal, operation: () => Promise<T>) {
  try {
    const result = await operation();
    if (isKnowledgeAdmin(principal)) await recordAdminUsage(env, principal, "read");
    return result;
  } catch (error) {
    if (isKnowledgeAdmin(principal)) await recordAdminFailure(env, principal).catch(() => undefined);
    throw error;
  }
}

async function delegateWithBody(request: Request, body: string, env: Env, principal: McpPrincipal) {
  const delegated = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
  return handleMcpRequest(delegated, env, principal);
}

async function mergeToolList(response: Response, principal: McpPrincipal): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  let payload: { result?: { tools?: unknown[] } };
  try {
    payload = await response.clone().json() as { result?: { tools?: unknown[] } };
  } catch {
    return response;
  }
  if (!Array.isArray(payload.result?.tools)) return response;

  payload.result.tools.push(...versionTools);
  if (isKnowledgeAdmin(principal)) payload.result.tools.push(restoreVersionTool);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export async function handleVersionAwareMcpRequest(request: Request, env: Env, principal: McpPrincipal): Promise<Response> {
  if (request.method !== "POST") return handleMcpRequest(request, env, principal);

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
    return mergeToolList(await delegateWithBody(request, body, env, principal), principal);
  }
  if (message.method !== "tools/call") {
    return delegateWithBody(request, body, env, principal);
  }

  const name = typeof message.params?.name === "string" ? message.params.name : "";
  const args = message.params?.arguments ?? {};
  try {
    if (name === "list_note_versions") {
      requireReadScope(principal);
      const input = listVersionsInput.parse(args);
      const result = await trackedRead(env, principal, () => listNoteVersions(env, principal, input.note_id));
      return jsonRpcResponse(message.id, toolResult(result));
    }
    if (name === "read_note_version") {
      requireReadScope(principal);
      const input = readVersionInput.parse(args);
      const result = await trackedRead(env, principal, () => readNoteVersion(env, principal, input.note_id, input.version));
      return jsonRpcResponse(message.id, toolResult(result));
    }
    if (name === "restore_note_version") {
      if (!isKnowledgeAdmin(principal)) throw new ApiError(403, "scope_required", "Token 缺少 knowledge:admin 权限");
      const input = restoreVersionInput.parse(args);
      const result = await runAdminMutation(
        env,
        principal,
        input.operation_id,
        "restore_note_version",
        {
          note_id: input.note_id,
          expected_version: input.expected_version,
          source_version: input.source_version,
        },
        () => restoreNoteVersion(env, principal, input.note_id, input.expected_version, input.source_version),
      );
      return jsonRpcResponse(message.id, toolResult(result));
    }
  } catch (error) {
    if (error instanceof ZodError) return invalidParams(message.id, error);
    if (error instanceof ApiError) return jsonRpcResponse(message.id, toolError(error));
    throw error;
  }

  return delegateWithBody(request, body, env, principal);
}
