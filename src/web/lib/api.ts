import type { ApiEnvelope, ApiErrorEnvelope } from "@shared/contracts";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (import.meta.env.DEV) headers.set("x-dev-user-email", "admin@example.com");

  const response = await fetch(path, { credentials: "same-origin", ...init, headers });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | ApiErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : null;
    throw new ApiClientError(response.status, error?.code ?? "request_failed", error?.message ?? `请求失败 (${response.status})`, error?.details);
  }
  if (!payload || !("data" in payload)) throw new ApiClientError(502, "invalid_response", "服务返回了无法识别的数据");
  return payload.data;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
