import { flushPromises, mount, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, onMounted } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import App from "@web/App.vue";
import AppShell from "@web/components/AppShell.vue";
import { api, ApiClientError } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import JobsView from "@web/views/JobsView.vue";
import KnowledgeView from "@web/views/KnowledgeView.vue";
import LoginView from "@web/views/LoginView.vue";
import TokensView from "@web/views/TokensView.vue";

vi.mock("@web/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@web/lib/api")>();
  return {
    ...actual,
    api: vi.fn(async () => []),
    jsonBody: (body: unknown) => ({ body: JSON.stringify(body) }),
  };
});

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

  it("does not mount a business route until initialization finishes", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    let resolveSession!: (value: unknown) => void;
    let resolveCollections!: (value: unknown) => void;
    const sessionPromise = new Promise<unknown>((resolve) => { resolveSession = resolve; });
    const collectionsPromise = new Promise<unknown>((resolve) => { resolveCollections = resolve; });
    let routeMounts = 0;
    const ProposalProbe = defineComponent({
      setup() {
        onMounted(() => {
          routeMounts += 1;
          void api("/api/v1/proposals");
        });
        return () => h("div", { "data-testid": "proposal-probe" }, "Proposals");
      },
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", name: "login", component: { template: "<div />" }, meta: { layout: "auth" } },
        { path: "/proposals", name: "proposals", component: ProposalProbe },
      ],
    });
    await router.push("/proposals");
    await router.isReady();
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === "/api/v1/session") return sessionPromise;
      if (path === "/api/v1/collections") return collectionsPromise;
      return Promise.resolve([]);
    });

    const wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(routeMounts).toBe(0);
    expect(wrapper.find('[data-testid="proposal-probe"]').exists()).toBe(false);

    resolveSession({ principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } });
    resolveCollections([]);
    await flushPromises();
    await flushPromises();

    expect(routeMounts).toBe(1);
    expect(wrapper.find('[data-testid="proposal-probe"]').exists()).toBe(true);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/api/v1/proposals")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps initialization failures visible and retries in place", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    let sessionAttempts = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/v1/session") {
        sessionAttempts += 1;
        if (sessionAttempts === 1) throw new ApiClientError(503, "worker_unavailable", "Worker 暂时不可用");
        return { principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } };
      }
      return [];
    });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", name: "login", component: { template: "<div />" }, meta: { layout: "auth" } },
        { path: "/knowledge", name: "knowledge", component: { template: '<div data-testid="knowledge-probe">Knowledge</div>' } },
      ],
    });
    await router.push("/knowledge");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("知识空间暂时无法载入");
    expect(wrapper.text()).toContain("worker_unavailable");
    expect(wrapper.find('[data-testid="knowledge-probe"]').exists()).toBe(false);
    await wrapper.get('[data-testid="initialization-retry"]').trigger("click");
    await flushPromises();

    expect(sessionAttempts).toBe(2);
    expect(wrapper.find('[data-testid="knowledge-probe"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("returns an expired session to login with the original destination", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/v1/session") throw new ApiClientError(401, "invalid_session", "管理会话无效或已过期");
      return [];
    });
    const router = createTestRouter();
    await router.push("/knowledge");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBe("/knowledge");
    expect(useAppStore().initializationError).toBeNull();
    wrapper.unmount();
  });

  it("opens a read-only workspace information dialog from settings", async () => {
    const router = createTestRouter();
    await router.push("/knowledge");
    await router.isReady();
    const store = useAppStore();
    store.session = { principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } };
    store.initialized = true;
    store.collections = [];

    const wrapper = mount(AppShell, { global: { plugins: [router], stubs: { Teleport: true } } });
    await wrapper.get('[data-testid="workspace-settings-trigger"]').trigger("click");

    expect(wrapper.get('[role="dialog"]').text()).toContain("工作区信息");
    expect(wrapper.get('[role="dialog"]').text()).toContain("admin@coylin.com");
    expect(wrapper.get('[role="dialog"]').text()).toContain("MCP Endpoint");
    wrapper.unmount();
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

  it("exposes mobile document and context drawers with explicit expanded state", async () => {
    const router = createTestRouter();
    await router.push("/knowledge");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [];

    const wrapper = mount(KnowledgeView, { global: { plugins: [router] } });
    const libraryTrigger = wrapper.get('[data-testid="mobile-library-trigger"]');

    expect(wrapper.find(".knowledge-mobile-dock").exists()).toBe(true);
    expect(wrapper.findAll(".mobile-dock-item")).toHaveLength(4);
    expect(libraryTrigger.attributes("aria-controls")).toBe("knowledge-library");
    expect(libraryTrigger.attributes("aria-expanded")).toBe("false");
    await libraryTrigger.trigger("click");
    await flushPromises();
    expect(libraryTrigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get("#knowledge-library").classes()).toContain("knowledge-library--open");

    await wrapper.get('[aria-label="关闭文档面板"]').trigger("click");
    await flushPromises();
    expect(libraryTrigger.attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
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
    const previewTrigger = wrapper.get('[data-testid="mobile-preview-trigger"]');
    await previewTrigger.trigger("click");
    expect(previewTrigger.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find(".markdown-editor").exists()).toBe(false);
    expect(wrapper.find(".markdown-preview").exists()).toBe(true);
    await wrapper.get('[data-testid="mobile-write-trigger"]').trigger("click");
    expect(wrapper.find(".markdown-editor").exists()).toBe(true);
    expect(wrapper.find(".markdown-preview").exists()).toBe(false);
    const inspectorTrigger = wrapper.get('[data-testid="mobile-inspector-trigger"]');
    expect(inspectorTrigger.attributes("aria-expanded")).toBe("false");
    await inspectorTrigger.trigger("click");
    await flushPromises();
    expect(inspectorTrigger.attributes("aria-expanded")).toBe("true");
    expect(wrapper.get("#knowledge-inspector").classes()).toContain("knowledge-inspector--open");
    await wrapper.get('[aria-label="关闭上下文面板"]').trigger("click");
    wrapper.unmount();
  });

  it("requires an exact name before deleting a collection", async () => {
    const router = createTestRouter();
    await router.push("/knowledge/collection-delete");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [{
      id: "collection-delete",
      name: "Disposable knowledge",
      description: "",
      role: "admin",
      noteCount: 0,
      updatedAt: "2026-08-03T08:00:00.000Z",
    }];
    vi.mocked(api).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/v1/collections/collection-delete" && init.method === "DELETE") {
        return { deleted: true, collectionId: "collection-delete" };
      }
      return [];
    });

    const wrapper = mount(KnowledgeView, { global: { plugins: [router], stubs: { Teleport: true } } });
    await flushPromises();
    await wrapper.get('[data-testid="delete-collection-trigger"]').trigger("click");
    const confirmButton = wrapper.get('[data-testid="confirm-delete-collection"]');
    expect(confirmButton.attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="delete-collection-confirmation"]').setValue("Disposable knowledge");
    expect(wrapper.get('[data-testid="confirm-delete-collection"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="confirm-delete-collection"]').trigger("click");
    await flushPromises();

    expect(api).toHaveBeenCalledWith("/api/v1/collections/collection-delete", { method: "DELETE" });
    expect(store.collections).toEqual([]);
    expect(router.currentRoute.value.fullPath).toBe("/knowledge");
    wrapper.unmount();
  });

  it("labels Token table cells for the mobile card layout", async () => {
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
    vi.mocked(api).mockResolvedValue([{
      id: "token-1",
      name: "Codex",
      prefix: "kc_test",
      collectionIds: ["collection-1"],
      scopes: ["knowledge:read"],
      createdAt: "2026-07-14T08:00:00.000Z",
      createdBy: "admin@coylin.com",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }]);

    const wrapper = mount(TokensView);
    await flushPromises();

    expect(wrapper.findAll("tbody td").map((cell) => cell.attributes("data-label"))).toEqual([
      "名称", "知识库", "权限", "最近使用", "状态", "操作",
    ]);
    wrapper.unmount();
  });

  it("labels job table cells for the mobile card layout", async () => {
    vi.mocked(api).mockResolvedValue([{
      id: "job-1",
      noteId: "note-123456789",
      version: 2,
      type: "index",
      status: "failed",
      attempts: 2,
      lastError: "Vectorize timeout",
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:01:00.000Z",
      completedAt: null,
    }]);

    const wrapper = mount(JobsView);
    await flushPromises();

    expect(wrapper.findAll("tbody td").map((cell) => cell.attributes("data-label"))).toEqual([
      "文档", "类型", "状态", "尝试", "更新时间", "错误", "操作",
    ]);
    wrapper.unmount();
  });
});
