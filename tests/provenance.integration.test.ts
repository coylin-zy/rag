import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, createCollection, jsonInit, mcpRequest, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function markdown(input: {
  title: string;
  body: string;
  source?: string;
  reviewAfter?: string;
  reviewedAt?: string;
  supersedes?: string[];
}) {
  const lines = ["---", `title: ${JSON.stringify(input.title)}`, "tags: [provenance]", "status: published"];
  if (input.source) lines.push(input.source);
  if (input.reviewAfter) lines.push(`review_after: ${input.reviewAfter}`);
  if (input.reviewedAt) lines.push(`reviewed_at: ${input.reviewedAt}`);
  if (input.supersedes?.length) lines.push(`supersedes: ${JSON.stringify(input.supersedes)}`);
  lines.push("---", "", `# ${input.title}`, "", input.body, "");
  return lines.join("\n");
}

async function createMarkdown(collectionId: string, value: string) {
  return apiRequest<{
    id: string;
    version: number;
    source?: unknown;
    reviewedAt?: string | null;
    reviewAfter?: string | null;
    supersedes?: string[];
    warnings?: string[];
  }>(`/api/v1/collections/${collectionId}/notes`, jsonInit("POST", { markdown: value }));
}

async function createAdminToken() {
  const created = await apiRequest<{ id: string; token: string }>(
    "/api/v1/tokens",
    jsonInit("POST", {
      name: "Provenance agent",
      collectionIds: [],
      scopes: ["knowledge:admin"],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
  if (!created.response.ok || !("data" in created.body)) throw new Error("Token creation failed");
  return created.body.data;
}

describe("knowledge provenance and freshness", () => {
  it("keeps old Markdown compatible while persisting portable provenance metadata", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Provenance compatibility");

    const legacy = await createMarkdown(collection.id, markdown({ title: "Legacy", body: "No new fields." }));
    expect(legacy.response.status).toBe(201);
    expect("data" in legacy.body && legacy.body.data).toMatchObject({
      version: 1,
      source: null,
      reviewedAt: null,
      reviewAfter: null,
      supersedes: [],
      warnings: [],
    });

    const observedAt = "2026-08-20T10:00:00.000Z";
    const reviewAfter = "2999-01-01T00:00:00.000Z";
    const sourced = await createMarkdown(collection.id, markdown({
      title: "Sourced",
      body: "Portable provenance.",
      source: [
        "source:",
        "  type: url",
        "  uri: https://example.com/spec",
        "  label: Example specification",
        `  observed_at: ${observedAt}`,
      ].join("\n"),
      reviewAfter,
    }));
    expect(sourced.response.status).toBe(201);
    if (!("data" in sourced.body)) throw new Error("Sourced note creation failed");
    expect(sourced.body.data).toMatchObject({
      source: {
        type: "url",
        uri: "https://example.com/spec",
        label: "Example specification",
        observed_at: observedAt,
      },
      reviewAfter,
      warnings: [],
    });

    const row = await env.DB.prepare(`
      SELECT source_json AS sourceJson, observed_at AS observedAt, review_after AS reviewAfter
      FROM notes WHERE id = ?
    `).bind(sourced.body.data.id).first<{ sourceJson: string; observedAt: string; reviewAfter: string }>();
    expect(JSON.parse(row?.sourceJson ?? "null")).toMatchObject({ type: "url", uri: "https://example.com/spec" });
    expect(row?.observedAt).toBe(observedAt);
    expect(row?.reviewAfter).toBe(reviewAfter);
  });

  it("rejects source credentials, common secrets, self references and cross-collection supersedes", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Provenance validation");

    const credentialUrl = await createMarkdown(collection.id, markdown({
      title: "Credential URL",
      body: "Rejected.",
      source: [
        "source:",
        "  type: url",
        "  uri: https://user:password@example.com/private",
      ].join("\n"),
    }));
    expect(credentialUrl.response.status).toBe(422);
    expect("error" in credentialUrl.body && credentialUrl.body.error.code).toBe("source_uri_credentials_forbidden");

    const secretLabel = await createMarkdown(collection.id, markdown({
      title: "Secret label",
      body: "Rejected.",
      source: [
        "source:",
        "  type: manual",
        "  uri: null",
        "  label: api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
      ].join("\n"),
    }));
    expect(secretLabel.response.status).toBe(422);
    expect("error" in secretLabel.body && secretLabel.body.error.code).toBe("provenance_secret_detected");

    const target = await createMarkdown(collection.id, markdown({ title: "Target", body: "Target body." }));
    if (!("data" in target.body)) throw new Error("Target creation failed");
    const valid = await createMarkdown(collection.id, markdown({
      title: "Replacement",
      body: "Supersedes target.",
      supersedes: [target.body.data.id],
    }));
    expect(valid.response.status).toBe(201);

    const otherCollection = await createCollection("Other provenance collection");
    const otherTarget = await createMarkdown(otherCollection.id, markdown({ title: "Other target", body: "Other." }));
    if (!("data" in otherTarget.body)) throw new Error("Other target creation failed");
    const cross = await createMarkdown(collection.id, markdown({
      title: "Cross reference",
      body: "Must fail.",
      supersedes: [otherTarget.body.data.id],
    }));
    expect(cross.response.status).toBe(422);
    expect("error" in cross.body && cross.body.error.code).toBe("invalid_supersedes_target");

    if (!("data" in valid.body)) throw new Error("Replacement creation failed");
    const detail = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${valid.body.data.id}`);
    if (!("data" in detail.body)) throw new Error("Replacement read failed");
    const selfMarkdown = detail.body.data.markdown.replace(
      /supersedes:[\s\S]*?\n---/,
      `supersedes: [${valid.body.data.id}]\n---`,
    );
    const self = await apiRequest(
      `/api/v1/notes/${valid.body.data.id}`,
      jsonInit("PUT", { markdown: selfMarkdown }, { "if-match": `"${detail.body.data.version}"` }),
    );
    expect(self.response.status).toBe(422);
    expect("error" in self.body && self.body.error.code).toBe("supersedes_self");
  });

  it("marks overdue knowledge explicitly and records human review as a new immutable version", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Freshness review");
    const created = await createMarkdown(collection.id, markdown({
      title: "Overdue",
      body: "Needs review.",
      source: [
        "source:",
        "  type: project",
        "  uri: project://knowledge-core/freshness",
        "  label: Project state",
        "  observed_at: 2026-08-01T00:00:00.000Z",
      ].join("\n"),
      reviewAfter: "2000-01-01T00:00:00.000Z",
    }));
    expect(created.response.status).toBe(201);
    if (!("data" in created.body)) throw new Error("Overdue creation failed");
    expect(created.body.data.warnings).toEqual(["review_due"]);

    const due = await apiRequest<Array<{ id: string; warnings: string[] }>>(
      `/api/v1/collections/${collection.id}/review-due`,
    );
    expect("data" in due.body && due.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.data.id, warnings: ["review_due"] }),
    ]));

    const future = "2999-01-01T00:00:00.000Z";
    const reviewed = await apiRequest<{ version: number; reviewedAt: string; reviewAfter: string; warnings: string[] }>(
      `/api/v1/notes/${created.body.data.id}/review`,
      jsonInit("POST", { nextReviewAfter: future }, { "if-match": '"1"' }),
    );
    expect(reviewed.response.status).toBe(200);
    expect("data" in reviewed.body && reviewed.body.data).toMatchObject({ version: 2, reviewAfter: future, warnings: [] });

    const v1 = await env.NOTES.get(`versions/${collection.id}/${created.body.data.id}/1.md`);
    const v2 = await env.NOTES.get(`versions/${collection.id}/${created.body.data.id}/2.md`);
    expect(await v1?.text()).toContain("review_after: 2000-01-01T00:00:00.000Z");
    expect(await v2?.text()).toContain("reviewed_at:");
    expect(await v2?.text()).toContain(`review_after: ${future}`);
    const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE resource_id = ? ORDER BY created_at DESC LIMIT 5")
      .bind(created.body.data.id)
      .all<{ action: string }>();
    expect(audit.results?.map((row) => row.action)).toContain("note.review");
  });

  it("does not let a knowledge-admin Agent forge reviewed_at", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Human review boundary");
    const created = await createMarkdown(collection.id, markdown({ title: "Human reviewed", body: "Original." }));
    if (!("data" in created.body)) throw new Error("Note creation failed");
    const reviewed = await apiRequest<{ version: number; reviewedAt: string }>(
      `/api/v1/notes/${created.body.data.id}/review`,
      jsonInit("POST", { nextReviewAfter: null }, { "if-match": '"1"' }),
    );
    if (!("data" in reviewed.body)) throw new Error("Human review failed");
    const originalReviewedAt = reviewed.body.data.reviewedAt;

    const current = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${created.body.data.id}`);
    if (!("data" in current.body)) throw new Error("Current note read failed");
    const forgedMarkdown = current.body.data.markdown.replace(
      /reviewed_at: .+\n/,
      "reviewed_at: 2999-01-01T00:00:00.000Z\n",
    ).replace("Original.", "Agent edit.");
    const token = await createAdminToken();
    const response = await mcpRequest(token.token, "tools/call", {
      name: "update_note",
      arguments: {
        operation_id: crypto.randomUUID(),
        note_id: created.body.data.id,
        expected_version: current.body.data.version,
        markdown: forgedMarkdown,
      },
    });
    const payload = await response.json() as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(payload.result?.isError).toBe(true);

    const row = await env.DB.prepare("SELECT version, reviewed_at AS reviewedAt FROM notes WHERE id = ?")
      .bind(created.body.data.id)
      .first<{ version: number; reviewedAt: string }>();
    expect(row).toMatchObject({ version: 2, reviewedAt: originalReviewedAt });
  });
});
