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

  it("starts a same-origin ZIP download after preparing an export", async () => {
    const router = createTestRouter();
    await router.push("/knowledge/collection-export");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [{
      id: "collection-export",
      name: "Exportable knowledge",
      description: "",
      role: "admin",
      noteCount: 0,
      updatedAt: "2026-08-23T08:00:00.000Z",
    }];
    vi.mocked(api).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/v1/collections/collection-export/notes") return [];
      if (path === "/api/v1/collections/collection-export/export" && init.method === "POST") {
        return {
          manifestHash: "a".repeat(64),
          objects: [{ logicalPath: "notes/example.md" }],
          archiveName: "knowledge-core-collection-export-portable.zip",
          downloadUrl: `/api/v1/collections/collection-export/export/archive?includeHistory=false&createdAt=${encodeURIComponent("2026-08-23T08:00:00.000Z")}&manifestHash=${"a".repeat(64)}`,
        };
      }
      return [];
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const wrapper = mount(KnowledgeView, { global: { plugins: [router], stubs: { Teleport: true } } });
    await flushPromises();
    await wrapper.get('[title="导入导出"]').trigger("click");
    await wrapper.get(".transfer-section .button").trigger("click");
    await flushPromises();

    expect(api).toHaveBeenCalledWith("/api/v1/collections/collection-export/export", {
      method: "POST",
      body: JSON.stringify({ includeHistory: false }),
    });
    expect(click).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("requires an exact name before moving a collection to trash", async () => {
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
      if (path === "/api/v1/collections/collection-delete/trash" && init.method === "POST") {
        return { trashed: true, collectionId: "collection-delete" };
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

    expect(api).toHaveBeenCalledWith("/api/v1/collections/collection-delete/trash", {
      method: "POST",
      body: JSON.stringify({
        expectedUpdatedAt: "2026-08-03T08:00:00.000Z",
        confirmName: "Disposable knowledge",
        reason: "网页管理端移入回收站",
      }),
    });
    expect(store.collections).toEqual([]);
    expect(router.currentRoute.value.fullPath).toBe("/knowledge");
    wrapper.unmount();
  });

  it("lists recoverable notes and collections and sends optimistic restore guards", async () => {
    const router = createTestRouter();
    await router.push("/knowledge/collection-active");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    const activeCollection = {
      id: "collection-active",
      name: "Active knowledge",
      description: "",
      role: "admin" as const,
      noteCount: 0,
      updatedAt: "2026-08-10T08:00:00.000Z",
    };
    store.collections = [activeCollection];
    const deletedAt = "2026-08-10T08:30:00.000Z";
    const trashedAt = "2026-08-10T09:00:00.000Z";
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/v1/collections/collection-active/notes") return [];
      if (path === "/api/v1/trash/notes?collectionId=collection-active") {
        return [{
          id: "note-deleted",
          collectionId: "collection-active",
          title: "Recoverable note",
          tags: [],
          status: "deleted",
          version: 3,
          indexedVersion: null,
          updatedAt: deletedAt,
          updatedBy: "admin@example.com",
          deletedFromStatus: "published",
          deletedAt,
          deletedBy: "admin@example.com",
          deleteReason: "cleanup",
        }];
      }
      if (path === "/api/v1/trash/collections") {
        return [{
          id: "collection-trashed",
          name: "Archived project",
          description: "",
          role: "admin",
          noteCount: 4,
          deletedNoteCount: 1,
          updatedAt: trashedAt,
          trashedAt,
          trashedBy: "admin@example.com",
          trashReason: "paused",
          purgeAfter: "2026-09-09T09:00:00.000Z",
        }];
      }
      if (path === "/api/v1/collections") return [activeCollection];
      if (path.includes("/restore")) return { restored: true };
      return [];
    });

    const wrapper = mount(KnowledgeView, { global: { plugins: [router], stubs: { Teleport: true } } });
    await flushPromises();
    await wrapper.get('[data-testid="open-trash"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Recoverable note");
    expect(wrapper.text()).toContain("Archived project");

    const restoreButtons = wrapper.findAll(".trash-row .button");
    await restoreButtons[0].trigger("click");
    await flushPromises();
    expect(api).toHaveBeenCalledWith("/api/v1/notes/note-deleted/restore-deleted", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 3, expectedDeletedAt: deletedAt }),
    });

    const refreshedButtons = wrapper.findAll(".trash-row .button");
    await refreshedButtons[1].trigger("click");
    await flushPromises();
    expect(api).toHaveBeenCalledWith("/api/v1/collections/collection-trashed/restore", {
      method: "POST",
      body: JSON.stringify({ expectedTrashedAt: trashedAt }),
    });
    expect(router.currentRoute.value.fullPath).toBe("/knowledge/collection-trashed");
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
      "名称", "知识库", "权限", "风控与用量", "最近使用", "状态", "操作",
    ]);
    wrapper.unmount();
  });

  it("creates an exclusive global Agent Token payload with a short default lifetime", async () => {
    const store = useAppStore();
    store.initialized = true;
    store.session = { principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } };
    store.collections = [];
    let submitted: Record<string, unknown> | null = null;
    vi.mocked(api).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/v1/tokens" && init.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return {
          id: "token-admin",
          name: "Trusted Codex",
          prefix: "kcore_admin",
          token: "kcore_once",
          collectionIds: [],
          scopes: ["knowledge:admin"],
          createdAt: "2026-08-10T08:00:00.000Z",
          createdBy: "admin@coylin.com",
          expiresAt: submitted?.expiresAt ?? null,
          lastUsedAt: null,
          revokedAt: null,
        };
      }
      return [];
    });

    const wrapper = mount(TokensView, { global: { stubs: { Teleport: true } } });
    await flushPromises();
    await wrapper.get('[data-testid="create-token-trigger"]').trigger("click");
    await wrapper.get("#token-name").setValue("Trusted Codex");
    await wrapper.get('[data-testid="token-scope-admin"]').setValue(true);

    expect((wrapper.get('[data-testid="token-scope-read"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain("所有当前和未来创建的知识库");
    expect(wrapper.text()).toContain("不允许管理 Token、成员或管理员账号");
    expect((wrapper.get("#token-expiry").element as HTMLInputElement).value).not.toBe("");

    await wrapper.get('[data-testid="token-scope-read"]').setValue(true);
    expect((wrapper.get('[data-testid="token-scope-admin"]').element as HTMLInputElement).checked).toBe(false);
    await wrapper.get('[data-testid="token-scope-admin"]').setValue(true);
    await wrapper.get("#token-form").trigger("submit");
    await flushPromises();

    expect(submitted).toMatchObject({
      name: "Trusted Codex",
      collectionIds: [],
      scopes: ["knowledge:admin"],
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      maxRequestsPerMinute: 60,
      maxWritesPerHour: 30,
    });
    expect(wrapper.text()).toContain("kcore_once");
    wrapper.unmount();
  });

  it("blocks a global Agent Token without a valid expiry and exposes emergency revoke", async () => {
    const store = useAppStore();
    store.initialized = true;
    store.session = { principal: { email: "admin@coylin.com", subject: "admin", bootstrapAdmin: true } };
    store.collections = [];
    vi.mocked(api).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/v1/tokens" && init.method === "POST") return { token: "kcore_once" };
      if (path === "/api/v1/tokens/revoke-knowledge-admin" && init.method === "POST") return { revokedCount: 2 };
      return [];
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const wrapper = mount(TokensView, { global: { stubs: { Teleport: true } } });
    await flushPromises();
    expect(wrapper.find('[data-testid="revoke-all-admin-tokens"]').exists()).toBe(true);
    await wrapper.get('[data-testid="create-token-trigger"]').trigger("click");
    await wrapper.get('[data-testid="token-scope-admin"]').setValue(true);
    await wrapper.get("#token-expiry").setValue("");
    expect(wrapper.text()).toContain("最高权限 Token 必须设置到期时间");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiryValue = new Date(expires.getTime() - expires.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await wrapper.get("#token-expiry").setValue(expiryValue);
    await wrapper.get("#token-request-limit").setValue("120");
    await wrapper.get("#token-write-limit").setValue("40");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="revoke-all-admin-tokens"]').trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalled();
    expect(api).toHaveBeenCalledWith("/api/v1/tokens/revoke-knowledge-admin", { method: "POST" });
    wrapper.unmount();
    confirm.mockRestore();
  });

  it("does not offer the global Agent permission to non-bootstrap administrators", async () => {
    const store = useAppStore();
    store.initialized = true;
    store.session = { principal: { email: "collection-admin@example.com", subject: "admin", bootstrapAdmin: false } };
    store.collections = [{
      id: "22222222-2222-4222-8222-222222222222",
      name: "Scoped collection",
      description: "",
      role: "admin",
      noteCount: 0,
      updatedAt: "2026-08-10T08:00:00.000Z",
    }];

    const wrapper = mount(TokensView, { global: { stubs: { Teleport: true } } });
    await flushPromises();
    await wrapper.get('[data-testid="create-token-trigger"]').trigger("click");

    expect(wrapper.find('[data-testid="token-scope-admin"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("最高知识权限");
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
