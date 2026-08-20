import { describe, expect, it } from "vitest";

import { buildVersionDiff, parseVersionDocument } from "@web/lib/versionDiff";

describe("version diff", () => {
  it("separates frontmatter, ignores generated version and keeps historical HTML as plain text data", () => {
    const before = `---\nid: 11111111-1111-4111-8111-111111111111\ntitle: Old title\ntags: [one]\nstatus: published\nversion: 1\n---\n\n# Heading\n\n<script>globalThis.__DIFF_XSS__ = true</script>\nold line`;
    const after = `---\nid: 11111111-1111-4111-8111-111111111111\ntitle: New title\ntags: [one, two]\nstatus: draft\nversion: 9\n---\n\n# Heading\n\n<script>globalThis.__DIFF_XSS__ = true</script>\nnew line`;

    const parsed = parseVersionDocument(before);
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.metadata).not.toHaveProperty("version");
    expect(parsed.body).toContain("<script>globalThis.__DIFF_XSS__ = true</script>");

    const diff = buildVersionDiff(before, after);
    expect(diff.identityMismatch).toBe(false);
    expect(diff.metadataBefore).toMatchObject({ title: "Old title", status: "published" });
    expect(diff.metadataAfter).toMatchObject({ title: "New title", status: "draft" });
    expect(diff.metadataBefore).not.toHaveProperty("version");
    expect(diff.metadataAfter).not.toHaveProperty("version");
    expect(diff.rows.some((row) => row.oldText.includes("<script>") || row.newText.includes("<script>"))).toBe(true);
    expect(diff.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "remove", oldText: "old line" }),
      expect.objectContaining({ kind: "add", newText: "new line" }),
    ]));
  });

  it("detects an unexpected document identity change", () => {
    const before = `---\nid: 11111111-1111-4111-8111-111111111111\ntitle: Same\ntags: []\nstatus: published\nversion: 1\n---\n\nbody`;
    const after = `---\nid: 22222222-2222-4222-8222-222222222222\ntitle: Same\ntags: []\nstatus: published\nversion: 2\n---\n\nbody`;
    expect(buildVersionDiff(before, after).identityMismatch).toBe(true);
  });

  it("bounds a very large diff instead of emitting an unbounded DOM-sized row set", () => {
    const bodyBefore = Array.from({ length: 2500 }, (_, index) => `old-${index}`).join("\n");
    const bodyAfter = Array.from({ length: 2500 }, (_, index) => `new-${index}`).join("\n");
    const before = `---\nid: 11111111-1111-4111-8111-111111111111\ntitle: Large\ntags: []\nstatus: published\nversion: 1\n---\n\n${bodyBefore}`;
    const after = `---\nid: 11111111-1111-4111-8111-111111111111\ntitle: Large\ntags: []\nstatus: published\nversion: 2\n---\n\n${bodyAfter}`;

    const diff = buildVersionDiff(before, after);
    expect(diff.truncated).toBe(true);
    expect(diff.rows.length).toBeLessThanOrEqual(1600);
    expect(diff.rows.some((row) => row.kind === "truncated")).toBe(true);
  });
});
