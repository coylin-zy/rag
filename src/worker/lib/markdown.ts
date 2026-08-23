import YAML from "yaml";
import { z } from "zod";

import { MAX_MARKDOWN_BYTES, sourceMetadataSchema, utf8ByteLength } from "@shared/contracts";
import { stripFrontmatter } from "@shared/markdown";

import { ApiError } from "./errors";
import { validateSourceMetadata } from "./provenance";
import { uniqueStrings } from "./utils";

export { stripFrontmatter } from "@shared/markdown";

const frontmatterSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  status: z.enum(["draft", "published"]).default("published"),
  version: z.number().int().positive().optional(),
  source: sourceMetadataSchema.nullable().optional(),
  review_after: z.string().datetime().nullable().optional(),
  reviewed_at: z.string().datetime().nullable().optional(),
  supersedes: z.array(z.string().uuid()).max(50).default([]),
});

export interface MarkdownDocument {
  frontmatter: z.infer<typeof frontmatterSchema>;
  body: string;
}

export function assertMarkdownSize(markdown: string): void {
  if (utf8ByteLength(markdown) > MAX_MARKDOWN_BYTES) {
    throw new ApiError(413, "markdown_too_large", "Markdown 的 UTF-8 大小不能超过 2 MiB");
  }
}

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  assertMarkdownSize(markdown);
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    throw new ApiError(422, "frontmatter_required", "Markdown 必须以 YAML frontmatter 开头");
  }

  let raw: unknown;
  try {
    raw = YAML.parse(match[1]);
  } catch {
    throw new ApiError(422, "invalid_frontmatter", "YAML frontmatter 无法解析");
  }

  const frontmatter = frontmatterSchema.parse(raw);
  const body = normalized.slice(match[0].length).trim();
  if (!body) throw new ApiError(422, "empty_markdown", "Markdown 正文不能为空");

  return {
    frontmatter: {
      ...frontmatter,
      tags: uniqueStrings(frontmatter.tags),
      supersedes: uniqueStrings(frontmatter.supersedes),
    },
    body,
  };
}

export function serializeMarkdownDocument(document: MarkdownDocument): string {
  const yaml = YAML.stringify(document.frontmatter, { lineWidth: 0 }).trim();
  return `---\n${yaml}\n---\n\n${document.body.trim()}\n`;
}

export function canonicalizeMarkdown(
  markdown: string,
  identity: {
    id: string;
    version: number;
    status?: "draft" | "published";
    reviewedAt?: string | null;
    allowReviewedAtChange?: boolean;
    reviewAfter?: string | null;
    allowReviewAfterChange?: boolean;
  },
): MarkdownDocument & { markdown: string } {
  const parsed = parseMarkdownDocument(markdown);
  if (parsed.frontmatter.id && parsed.frontmatter.id !== identity.id) {
    throw new ApiError(409, "note_id_mismatch", "frontmatter 中的文档 ID 与当前文档不一致");
  }

  const currentReviewedAt = identity.reviewedAt ?? null;
  const submittedReviewedAt = parsed.frontmatter.reviewed_at;
  if (!identity.allowReviewedAtChange && submittedReviewedAt !== undefined && (submittedReviewedAt ?? null) !== currentReviewedAt) {
    throw new ApiError(422, "reviewed_at_managed", "reviewed_at 只能通过人工复核操作更新");
  }

  const source = validateSourceMetadata(parsed.frontmatter.source);
  const reviewedAt = identity.allowReviewedAtChange ? (identity.reviewedAt ?? null) : currentReviewedAt;
  const reviewAfter = identity.allowReviewAfterChange
    ? (identity.reviewAfter ?? null)
    : (parsed.frontmatter.review_after ?? null);
  const frontmatter = {
    id: identity.id,
    title: parsed.frontmatter.title,
    tags: parsed.frontmatter.tags,
    status: identity.status ?? parsed.frontmatter.status,
    version: identity.version,
    ...(source ? { source } : {}),
    ...(reviewAfter ? { review_after: reviewAfter } : {}),
    ...(reviewedAt ? { reviewed_at: reviewedAt } : {}),
    supersedes: parsed.frontmatter.supersedes,
  };
  const canonical = { frontmatter, body: parsed.body };
  return { ...canonical, markdown: serializeMarkdownDocument(canonical) };
}
