import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "@worker/lib/chunking";

describe("Markdown chunking", () => {
  it("tracks heading paths and ignores headings inside code fences", async () => {
    const chunks = await chunkMarkdown({
      noteId: "note-a",
      version: 1,
      title: "Architecture",
      markdown: `---\ntitle: Architecture\n---\n\n# Platform\n\nIntro\n\n## Worker\n\n\`\`\`md\n# not a heading\n\`\`\`\n\nDetails`,
    });
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["Platform"],
      ["Platform", "Worker"],
    ]);
    expect(chunks[1].content).toContain("# not a heading");
  });

  it("keeps chunks within the 1500 character target and overlaps long text", async () => {
    const body = `${"甲".repeat(1400)}\n\n${"乙".repeat(600)}`;
    const chunks = await chunkMarkdown({
      noteId: "note-b",
      version: 7,
      title: "Long",
      markdown: `---\ntitle: Long\n---\n\n# Long\n\n${body}`,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => [...chunk.content].length <= 1500)).toBe(true);
    expect(chunks[1].content).toContain("甲".repeat(100));
  });

  it("counts Unicode code points and never splits a surrogate pair", async () => {
    const chunks = await chunkMarkdown({
      noteId: "note-unicode",
      version: 1,
      title: "Unicode",
      markdown: `---\ntitle: Unicode\n---\n\n# Unicode\n\n${"知".repeat(900)}${"🙂".repeat(900)}`,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk.content).length <= 1500)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk.content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")))).toBe(true);
  });

  it("keeps a fenced code block with blank lines together when it fits", async () => {
    const code = "```ts\nconst first = 1;\n\nconst second = 2;\n```";
    const chunks = await chunkMarkdown({
      noteId: "note-code",
      version: 1,
      title: "Code",
      markdown: `---\ntitle: Code\n---\n\n# Code\n\n${"前".repeat(1300)}\n\n${code}\n\n${"后".repeat(300)}`,
    });
    const codeChunk = chunks.find((chunk) => chunk.content.includes("const first"));
    expect(codeChunk?.content).toContain("const second");
    expect(codeChunk?.content).toContain("```ts");
    expect(codeChunk?.content).toContain("```");
  });

  it("generates deterministic IDs and content hashes for a version", async () => {
    const input = { noteId: "note-c", version: 2, title: "Stable", markdown: "---\ntitle: Stable\n---\n\n# Stable\n\nBody" };
    expect(await chunkMarkdown(input)).toEqual(await chunkMarkdown(input));
    expect((await chunkMarkdown({ ...input, version: 3 }))[0].id).not.toBe((await chunkMarkdown(input))[0].id);
  });
});
