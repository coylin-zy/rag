import { describe, expect, it } from "vitest";

import { MAX_MARKDOWN_BYTES, proposalSchema, saveNoteSchema, utf8ByteLength } from "@shared/contracts";
import { ApiError } from "@worker/lib/errors";
import {
  canonicalizeMarkdown,
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from "@worker/lib/markdown";

const id = "11111111-1111-4111-8111-111111111111";

describe("Markdown frontmatter", () => {
  it("enforces the 2 MiB limit using UTF-8 bytes", () => {
    const multibyte = "知".repeat(Math.floor(MAX_MARKDOWN_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(MAX_MARKDOWN_BYTES);
    expect(utf8ByteLength(multibyte)).toBeGreaterThan(MAX_MARKDOWN_BYTES);
    expect(saveNoteSchema.safeParse({ markdown: multibyte }).success).toBe(false);
    expect(proposalSchema.safeParse({
      collectionId: crypto.randomUUID(),
      title: "oversized",
      body: multibyte,
      tags: [],
      source: "test",
    }).success).toBe(false);
    expect(saveNoteSchema.safeParse({ markdown: "a".repeat(MAX_MARKDOWN_BYTES) }).success).toBe(true);
  });

  it("parses CRLF, normalizes tags and applies defaults", () => {
    const parsed = parseMarkdownDocument("---\r\ntitle: 测试\r\ntags: [MCP, MCP, ' RAG ']\r\n---\r\n\r\n正文\r\n");
    expect(parsed.frontmatter).toEqual({ title: "测试", tags: ["MCP", "RAG"], status: "published" });
    expect(parsed.body).toBe("正文");
  });

  it("writes server-owned identity and version", () => {
    const result = canonicalizeMarkdown("---\ntitle: 测试\ntags: []\nstatus: draft\n---\n\n正文", { id, version: 3 });
    expect(result.frontmatter).toMatchObject({ id, version: 3, status: "draft" });
    expect(parseMarkdownDocument(result.markdown).frontmatter.version).toBe(3);
  });

  it("rejects missing metadata, empty bodies and identity changes", () => {
    expect(() => parseMarkdownDocument("# no metadata")).toThrow(ApiError);
    expect(() => parseMarkdownDocument("---\ntitle: empty\n---\n")).toThrow(ApiError);
    expect(() => canonicalizeMarkdown(
      "---\nid: 22222222-2222-4222-8222-222222222222\ntitle: wrong\n---\n\nbody",
      { id, version: 2 },
    )).toThrowError(expect.objectContaining({ code: "note_id_mismatch" }));
  });

  it("round-trips YAML values without changing the body", () => {
    const markdown = serializeMarkdownDocument({
      frontmatter: { title: "A: B", tags: ["中文", "mcp"], status: "published" },
      body: "# Heading\n\n```ts\nconst value = 1;\n```",
    });
    expect(parseMarkdownDocument(markdown).body).toContain("const value = 1");
  });
});
