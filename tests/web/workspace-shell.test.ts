import { flushPromises, mount, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import AppShell from "@web/components/AppShell.vue";
import { api } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import KnowledgeView from "@web/views/KnowledgeView.vue";
import LoginView from "@web/views/LoginView.vue";

vi.mock("@web/lib/api", () => ({
  api: vi.fn(async () => []),
  jsonBody: (body: unknown) => ({ body: JSON.stringify(body) }),
}));

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/login", name: "login", component: { template: "<div />" }, meta: { layout: "auth" } },
      { path: "/knowledge", name: "knowledge", component: { template: "<div />" } },
      { path: "/knowledge/:collectionId", name: "collection", component: { template: "<div />" } },
      { path: "/knowledge/:collectionId/notes/:noteId", name: "note", component: { template: "<div />" } },
      { path: "/search", component: { template: "<div />" } },
      { path: "/proposals", component: { template: "<div />" } },
      { path: "/tokens", component: { template: "<div />" } },
      { path: "/jobs", component: { template: "<div />" } },
    ],
  });
}

describe("redesigned workspace shell", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    vi.mocked(api).mockResolvedValue([]);
    setActivePinia(createPinia());
  });

  it("uses a compact product rail with all five core workflows", async () => {
    const router = createTestRouter();
    await router.push("/knowledge");
    await router.isReady();
    const store = useAppStore();
    store.session = { principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } };
    store.initialized = true;

    const wrapper = mount(AppShell, { global: { plugins: [router] } });

    expect(wrapper.find(".product-rail").exists()).toBe(true);
    expect(wrapper.findAll(".product-nav__item")).toHaveLength(5);
    expect(wrapper.text()).toContain("admin@coylin.com");
    expect(wrapper.find(".topbar").exists()).toBe(false);
  });

  it("presents login as a split product introduction and secure form", async () => {
    const router = createTestRouter();
    await router.push("/login");
    await router.isReady();

    const wrapper = mount(LoginView, { global: { plugins: [router] } });

    expect(wrapper.find(".login-context").exists()).toBe(true);
    expect(wrapper.find(".login-form-panel").exists()).toBe(true);
    expect((wrapper.get("#login-email").element as HTMLInputElement).value).toBe("admin@coylin.com");
  });

  it("keeps knowledge navigation, editor, and traceability in one workspace", async () => {
    const router = createTestRouter();
    await router.push("/knowledge");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [];

    const wrapper = shallowMount(KnowledgeView, { global: { plugins: [router] } });

    expect(wrapper.find(".knowledge-shell").exists()).toBe(true);
    expect(wrapper.find(".knowledge-library").exists()).toBe(true);
    expect(wrapper.find(".knowledge-inspector").exists()).toBe(true);
  });

  it("opens the first document when entering a populated collection", async () => {
    const router = createTestRouter();
    await router.push("/knowledge/collection-1");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [{
      id: "collection-1",
      name: "Agent handbook",
      description: "",
      role: "admin",
      noteCount: 1,
      updatedAt: "2026-07-14T08:00:00.000Z",
    }];
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/v1/collections/collection-1/notes") {
        return [{
          id: "note-1",
          collectionId: "collection-1",
          title: "Operating principles",
          tags: ["agents"],
          version: 1,
          indexedVersion: 1,
          updatedAt: "2026-07-14T08:00:00.000Z",
          updatedBy: "admin@coylin.com",
        }];
      }
      if (path === "/api/v1/notes/note-1") {
        return {
          id: "note-1",
          collectionId: "collection-1",
          title: "Operating principles",
          tags: ["agents"],
          version: 1,
          indexedVersion: 1,
          updatedAt: "2026-07-14T08:00:00.000Z",
          updatedBy: "admin@coylin.com",
          markdown: "# Operating principles",
        };
      }
      return [];
    });

    const wrapper = mount(KnowledgeView, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/knowledge/collection-1/notes/note-1");
    expect(wrapper.find(".markdown-editor").exists()).toBe(true);
  });
});
