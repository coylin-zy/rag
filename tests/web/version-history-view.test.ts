import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { api } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import VersionHistoryView from "@web/views/VersionHistoryView.vue";

vi.mock("@web/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@web/lib/api")>();
  return {
    ...actual,
    api: vi.fn(),
    jsonBody: (body: unknown) => ({ body: JSON.stringify(body) }),
  };
});

function routerFor(noteId = "note-1") {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/knowledge/:collectionId/notes/:noteId", component: { template: "<div />" } },
      { path: "/knowledge/:collectionId/notes/:noteId/versions", component: VersionHistoryView },
    ],
  });
}

const id = "11111111-1111-4111-8111-111111111111";
const currentMarkdown = `---\nid: ${id}\ntitle: Safe history\ntags: [security]\nstatus: published\nversion: 2\n---\n\n# Safe history\n\n<script>globalThis.__KC_DIFF_XSS__ = true</script>\nnew line`;
const oldMarkdown = `---\nid: ${id}\ntitle: Safe history\ntags: [security]\nstatus: published\nversion: 1\n---\n\n# Safe history\n\n<script>globalThis.__KC_DIFF_XSS__ = true</script>\nold line`;

describe("version history view", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    setActivePinia(createPinia());
    delete (globalThis as typeof globalThis & { __KC_DIFF_XSS__?: boolean }).__KC_DIFF_XSS__;
  });

  it("renders historical HTML as text and disables rollback for viewers", async () => {
    const router = routerFor();
    await router.push("/knowledge/collection-1/notes/note-1/versions");
    await router.isReady();
    const store = useAppStore();
    store.collections = [{
      id: "collection-1",
      name: "Viewer knowledge",
      description: "",
      role: "viewer",
      noteCount: 1,
      updatedAt: "2026-08-20T10:00:00.000Z",
    }];

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/v1/notes/note-1") {
        return {
          id: "note-1",
          collectionId: "collection-1",
          title: "Safe history",
          tags: ["security"],
          status: "published",
          version: 2,
          indexedVersion: 2,
          updatedAt: "2026-08-20T10:00:00.000Z",
          updatedBy: "admin@example.com",
          markdown: currentMarkdown,
        };
      }
      if (path === "/api/v1/notes/note-1/versions") {
        return [
          { noteId: "note-1", version: 2, title: "Safe history", createdAt: "2026-08-20T10:00:00.000Z", createdBy: "admin@example.com" },
          { noteId: "note-1", version: 1, title: "Safe history", createdAt: "2026-08-19T10:00:00.000Z", createdBy: "admin@example.com" },
        ];
      }
      if (path === "/api/v1/notes/note-1/versions/1") {
        return {
          noteId: "note-1",
          collectionId: "collection-1",
          currentVersion: 2,
          version: 1,
          title: "Safe history",
          createdAt: "2026-08-19T10:00:00.000Z",
          createdBy: "admin@example.com",
          markdown: oldMarkdown,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const wrapper = mount(VersionHistoryView, { global: { plugins: [router] } });
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("<script>globalThis.__KC_DIFF_XSS__ = true</script>");
    expect(wrapper.find("script").exists()).toBe(false);
    expect((globalThis as typeof globalThis & { __KC_DIFF_XSS__?: boolean }).__KC_DIFF_XSS__).toBeUndefined();
    expect(wrapper.get(".version-header .button").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("sends the current version as If-Match when an editor rolls back", async () => {
    const router = routerFor();
    await router.push("/knowledge/collection-1/notes/note-1/versions");
    await router.isReady();
    const store = useAppStore();
    store.collections = [{
      id: "collection-1",
      name: "Editable knowledge",
      description: "",
      role: "editor",
      noteCount: 1,
      updatedAt: "2026-08-20T10:00:00.000Z",
    }];

    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/notes/note-1" && !init) return {
        id: "note-1", collectionId: "collection-1", title: "Safe history", tags: ["security"], status: "published",
        version: 2, indexedVersion: 2, updatedAt: "2026-08-20T10:00:00.000Z", updatedBy: "admin@example.com", markdown: currentMarkdown,
      };
      if (path === "/api/v1/notes/note-1/versions") return [
        { noteId: "note-1", version: 2, title: "Safe history", createdAt: "2026-08-20T10:00:00.000Z", createdBy: "admin@example.com" },
        { noteId: "note-1", version: 1, title: "Safe history", createdAt: "2026-08-19T10:00:00.000Z", createdBy: "admin@example.com" },
      ];
      if (path === "/api/v1/notes/note-1/versions/1") return {
        noteId: "note-1", collectionId: "collection-1", currentVersion: 2, version: 1, title: "Safe history",
        createdAt: "2026-08-19T10:00:00.000Z", createdBy: "admin@example.com", markdown: oldMarkdown,
      };
      if (path === "/api/v1/notes/note-1/restore" && init?.method === "POST") return { version: 3 };
      throw new Error(`Unexpected path ${path}`);
    });

    const wrapper = mount(VersionHistoryView, { global: { plugins: [router] } });
    await flushPromises();
    await flushPromises();
    await wrapper.get(".version-header .button").trigger("click");
    await flushPromises();

    expect(api).toHaveBeenCalledWith("/api/v1/notes/note-1/restore", {
      method: "POST",
      headers: { "if-match": '"2"' },
      body: JSON.stringify({ version: 1 }),
    });
    wrapper.unmount();
  });
});
