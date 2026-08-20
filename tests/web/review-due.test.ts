import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import { api } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import ReviewDueView from "@web/views/ReviewDueView.vue";

vi.mock("@web/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@web/lib/api")>();
  return {
    ...actual,
    api: vi.fn(),
    jsonBody: (body: unknown) => ({ body: JSON.stringify(body) }),
  };
});

function routerForTest() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/review-due", component: ReviewDueView },
      { path: "/knowledge/:collectionId/notes/:noteId", component: { template: "<div />" } },
    ],
  });
}

const dueItem = {
  id: "11111111-1111-4111-8111-111111111111",
  collectionId: "22222222-2222-4222-8222-222222222222",
  title: "Outdated project state",
  version: 3,
  source: {
    type: "project" as const,
    uri: "project://robotics/status",
    label: "Robotics status",
    observed_at: "2026-08-01T00:00:00.000Z",
  },
  observedAt: "2026-08-01T00:00:00.000Z",
  reviewedAt: "2026-08-02T00:00:00.000Z",
  reviewAfter: "2026-08-10T00:00:00.000Z",
  warnings: ["review_due"] as ["review_due"],
};

describe("review due workspace", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    setActivePinia(createPinia());
  });

  it("shows provenance and sends an optimistic human review request", async () => {
    const router = routerForTest();
    await router.push("/review-due");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [{
      id: dueItem.collectionId,
      name: "Robotics",
      description: "",
      role: "editor",
      noteCount: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
    }];

    vi.mocked(api).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path.includes("/review-due") && init.method !== "POST") return [dueItem];
      if (path === `/api/v1/notes/${dueItem.id}/review` && init.method === "POST") {
        return { version: 4, reviewedAt: "2026-08-20T00:00:00.000Z", reviewAfter: null, warnings: [] };
      }
      return [];
    });

    const wrapper = mount(ReviewDueView, { global: { plugins: [router], stubs: { Teleport: true } } });
    await flushPromises();
    expect(wrapper.text()).toContain("Outdated project state");
    expect(wrapper.text()).toContain("Robotics status");
    expect(wrapper.text()).toContain("review_due");

    await wrapper.get("button.button--primary").trigger("click");
    await flushPromises();
    const dateInput = wrapper.get('input[type="date"]');
    await dateInput.setValue("");
    const confirmButtons = wrapper.findAll("button.button--primary");
    await confirmButtons[confirmButtons.length - 1].trigger("click");
    await flushPromises();

    expect(api).toHaveBeenCalledWith(`/api/v1/notes/${dueItem.id}/review`, {
      method: "POST",
      headers: { "if-match": '"3"' },
      body: JSON.stringify({ nextReviewAfter: null }),
    });
    wrapper.unmount();
  });

  it("keeps review controls disabled for viewers", async () => {
    const router = routerForTest();
    await router.push("/review-due");
    await router.isReady();
    const store = useAppStore();
    store.initialized = true;
    store.collections = [{
      id: dueItem.collectionId,
      name: "Robotics",
      description: "",
      role: "viewer",
      noteCount: 1,
      updatedAt: "2026-08-20T00:00:00.000Z",
    }];
    vi.mocked(api).mockResolvedValue([dueItem]);

    const wrapper = mount(ReviewDueView, { global: { plugins: [router], stubs: { Teleport: true } } });
    await flushPromises();
    const reviewButton = wrapper.findAll("button").find((button) => button.text().includes("标记已复核"));
    expect(reviewButton?.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
