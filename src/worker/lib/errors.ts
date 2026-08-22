import type { Context } from "hono";
import { ZodError } from "zod";

import type { ApiErrorEnvelope } from "@shared/contracts";
import type { AppVariables, Env } from "@worker/env";

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError(422, "validation_error", "请求数据不符合要求", error.flatten());
  }
  return new ApiError(500, "internal_error", "服务暂时不可用");
}

export function safeErrorSummary(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`.slice(0, 1000);
  const name = error instanceof Error && error.name ? error.name : "UnknownError";
  return `unexpected_failure: ${name}`;
}

export function errorResponse(c: Context<{ Bindings: Env; Variables: AppVariables }>, error: unknown) {
  const apiError = toApiError(error);
  const requestId = c.get("requestId") ?? crypto.randomUUID();

  if (apiError.status >= 500) {
    const failureKind = error instanceof Error ? "Error" : "NonError";
    console.error(JSON.stringify({
      event: "request.error",
      requestId,
      status: apiError.status,
      code: apiError.code,
      failureKind,
      hasCause: Boolean(error instanceof Error && error.cause),
    }));
  }

  const payload: ApiErrorEnvelope = {
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    },
    requestId,
  };

  return c.json(payload, apiError.status);
}
