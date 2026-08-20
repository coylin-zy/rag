import { MAX_MARKDOWN_BYTES, utf8ByteLength } from "@shared/contracts";

import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { parseMarkdownDocument } from "../lib/markdown";
import { assertNoProvenanceSecret } from "../lib/provenance";

export const MAX_IMPORT_ITEMS = 500;
export const MAX_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_PATH_BYTES = 512;

const RESERVED_IMPORT_PREFIXES = ["history/", "recovery/", "imports/"] as const;
const RESERVED_IMPORT_FILES = new Set(["manifest.json"]);

function invalidPath(message: string): never {
  throw new ApiError(422, "invalid_import_path", message);
}

export function normalizeImportPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) invalidPath("导入相对路径不能为空");
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    invalidPath("导入路径必须是相对路径");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) invalidPath("导入路径不能是 URL");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) invalidPath("导入路径不能包含控制字符");

  const normalized = trimmed.replace(/\\/g, "/").normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalidPath("导入路径不能包含空目录、. 或 ..");
  }
  if (!normalized.toLowerCase().endsWith(".md")) invalidPath("第一版导入只接受 .md 文件");
  if (utf8ByteLength(normalized) > MAX_IMPORT_PATH_BYTES) invalidPath("导入相对路径不能超过 512 UTF-8 字节");

  const lower = normalized.toLowerCase();
  if (RESERVED_IMPORT_FILES.has(lower) || RESERVED_IMPORT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new ApiError(422, "reserved_import_path", "导入路径使用了 Knowledge Core 保留名称");
  }
  return normalized;
}

export async function validateImportMarkdown(input: {
  relativePath: string;
  markdown: string;
  clientSha256?: string | null;
}) {
  const relativePath = normalizeImportPath(input.relativePath);
  const byteSize = utf8ByteLength(input.markdown);
  if (byteSize === 0) throw new ApiError(422, "empty_import_file", "导入 Markdown 不能为空");
  if (byteSize > MAX_MARKDOWN_BYTES) {
    throw new ApiError(413, "markdown_too_large", "单篇导入 Markdown 不能超过 2 MiB");
  }

  assertNoProvenanceSecret(input.markdown, "import.markdown");
  const document = parseMarkdownDocument(input.markdown);
  const sourceSha256 = await sha256(input.markdown.replace(/\r\n/g, "\n"));
  if (input.clientSha256 && input.clientSha256.toLowerCase() !== sourceSha256) {
    throw new ApiError(422, "import_hash_mismatch", "客户端 SHA-256 与服务端计算结果不一致");
  }

  return {
    relativePath,
    byteSize,
    sourceSha256,
    document,
  };
}

export function assertImportJobLimits(input: { itemCount: number; totalBytes: number }) {
  if (input.itemCount > MAX_IMPORT_ITEMS) {
    throw new ApiError(413, "import_item_limit", `单个导入任务最多 ${MAX_IMPORT_ITEMS} 篇 Markdown`);
  }
  if (input.totalBytes > MAX_IMPORT_TOTAL_BYTES) {
    throw new ApiError(413, "import_total_size_limit", "单个导入任务解压后的 Markdown 总量不能超过 100 MiB");
  }
}
