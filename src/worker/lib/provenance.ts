import type { FreshnessWarning, SourceMetadata } from "@shared/contracts";
import type { Env } from "@worker/env";

import { ApiError } from "./errors";

const ALLOWED_SOURCE_PROTOCOLS = new Set(["http:", "https:", "git:", "ssh:", "project:", "urn:"]);
const SENSITIVE_QUERY_KEY = /(?:token|secret|password|passwd|signature|session|credential|api[_-]?key|auth)/i;

export function validateSourceMetadata(source: SourceMetadata | null | undefined): SourceMetadata | null {
  if (!source) return null;
  const normalized: SourceMetadata = {
    type: source.type,
    uri: source.uri?.trim() || null,
    label: source.label?.trim() || null,
    observed_at: source.observed_at ?? null,
  };
  if (!normalized.uri) return normalized;

  let parsed: URL;
  try {
    parsed = new URL(normalized.uri);
  } catch {
    throw new ApiError(422, "invalid_source_uri", "source.uri 必须是受支持的绝对 URI");
  }
  if (!ALLOWED_SOURCE_PROTOCOLS.has(parsed.protocol)) {
    throw new ApiError(422, "invalid_source_uri_protocol", `source.uri 不允许使用 ${parsed.protocol} 协议`);
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(422, "source_uri_credentials_forbidden", "source.uri 不能包含用户名、密码或其他 URL userinfo");
  }
  for (const [key, value] of parsed.searchParams) {
    if (value && SENSITIVE_QUERY_KEY.test(key)) {
      throw new ApiError(422, "source_uri_credentials_forbidden", "source.uri 不能包含 Token、密钥、签名或会话类查询参数", {
        parameter: key,
      });
    }
  }
  if (source.type === "url" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(422, "invalid_source_uri_protocol", "url 来源只允许 http/https URI");
  }
  return normalized;
}

export function freshnessWarnings(reviewAfter: string | null | undefined, now = Date.now()): FreshnessWarning[] {
  if (!reviewAfter) return [];
  const deadline = Date.parse(reviewAfter);
  return Number.isFinite(deadline) && deadline < now ? ["review_due"] : [];
}

export async function assertSupersedesTargets(
  env: Env,
  collectionId: string,
  noteId: string,
  supersedes: string[],
): Promise<void> {
  const unique = [...new Set(supersedes)];
  if (unique.includes(noteId)) {
    throw new ApiError(422, "supersedes_self", "文档不能 supersede 自身");
  }
  if (unique.length === 0) return;

  const placeholders = unique.map(() => "?").join(",");
  const result = await env.DB.prepare(`
    SELECT id, collection_id AS collectionId, status FROM notes WHERE id IN (${placeholders})
  `).bind(...unique).all<{ id: string; collectionId: string; status: string }>();
  const rows = result.results ?? [];
  const valid = new Set(rows.filter((row) => row.collectionId === collectionId && row.status !== "deleted").map((row) => row.id));
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length) {
    throw new ApiError(422, "invalid_supersedes_target", "supersedes 只能引用同一活动知识库中的现有文档", { invalidIds: invalid });
  }
}
