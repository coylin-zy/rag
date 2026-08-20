import { afterEach, describe, expect, it, vi } from "vitest";

import { api, jsonBody } from "@web/lib/api";

afterEach(() => vi.restoreAllMocks());

describe("API note ETag guard", () => {
  it("reuses the last observed current-note ETag when a legacy restore call omits If-Match", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "note-guard", version: 2, markdown: "current" },
        requestId: "req-1",
      }), { status: 200, headers: { "content-type": "application/json", etag: '"2"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: "note-guard", version: 3 },
        requestId: "req-2",
      }), { status: 200, headers: { "content-type": "application/json", etag: '"3"' } }));

    await api("/api/v1/notes/note-guard");
    await api("/api/v1/notes/note-guard/restore", {
      method: "POST",
      ...jsonBody({ version: 1 }),
    });

    const restoreInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(restoreInit.headers);
    expect(headers.get("if-match")).toBe('"2"');
  });

  it("never replaces an explicit If-Match supplied by the version workspace", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { id: "note-explicit", version: 4 },
      requestId: "req-3",
    }), { status: 200, headers: { "content-type": "application/json", etag: '"4"' } }));

    await api("/api/v1/notes/note-explicit/restore", {
      method: "POST",
      headers: { "if-match": '"3"' },
      ...jsonBody({ version: 1 }),
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("if-match")).toBe('"3"');
  });
});
