import type { FreshnessWarning, SourceMetadata } from "@shared/contracts";
import type { Env } from "@worker/env";

import { ApiError } from "./errors";

const ALLOWED_SOURCE_PROTOCOLS = new Set(["http:", "https:", "git:", "ssh:", "project:", "urn:"]);

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "stripe_key", pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "knowledge_token", pattern: /\bkcore_[A-Za-z0-9_-]{20,}\b/ },
  { name: "auth_header", pattern: /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]/i },
  { name: "named_secret", pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session|password|passwd|secret)\s*[:=]\s*[^\s]{8,}/i },
];

export function assertNoProvenanceSecret(value: string, field: string): void {
  for (const candidate of SECRET_PATTERNS) {
    if (candidate.pattern.test(value)) {
      throw new ApiError(422, "provenance_secret_detected", `来源字段 ${field} 疑似包含敏感凭证`, {
        field,
        kind: candidate.name,
      });
    }
  }
}

export function validateSourceMetadata(source: SourceMetadata | null | undefined): SourceMetadata | null {
  if (!source) return null;
  const normalized: SourceMetadata = {
    type: source.type,
    uri: source.uri?.trim() || null,
    label: source.label?.trim() || null,
    observed_at: source.observed_at ?? null,
  };

  if (normalized.label) assertNoProvenanceSecret(normalized.label, "source.label");
  if (!normalized.uri) return normalized;

  assertNoProvenanceSecret(normalized.uri, "source.uri");
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
    SELECT id, collection_id AS collectionId, status
    FROM notes
    WHERE id IN (${placeholders})
  `).bind(...unique).all<{ id: string; collectionId: string; status: string }>();
  const rows = result.results ?? [];
  const valid = new Set(rows
    .filter((row) => row.collectionId === collectionId && row.status !== "deleted")
    .map((row) => row.id));
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length) {
    throw new ApiError(422, "invalid_supersedes_target", "supersedes 只能引用同一活动知识库中的现有文档", {
      invalidIds: invalid,
    });
  }
}
