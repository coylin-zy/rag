import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

import ProvenanceContextControl from "@web/components/ProvenanceContextControl.vue";
import { api } from "@web/lib/api";

vi.mock("@web/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@web/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const collectionId = "22222222-2222-4222-8222-222222222222";
const noteId = "11111111-1111-4111-8111-111111111111";

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/knowledge/:collectionId/notes/:noteId", component: { template: "<div />" } },
    ],
  });
}

describe("provenance context control", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    setActivePinia(createPinia());
  });

  it("shows source, review schedule and stale warning for the current note", async () => {
    const router = createTestRouter();
    await router.push(`/knowledge/${collectionId}/notes/${noteId}`);
    await router.isReady();
    vi.mocked(api).mockResolvedValue({
      id: noteId,
      collectionId,
      title: "Infrastructure state",
      tags: ["infra"],
      status: "published",
      version: 4,
      indexedVersion: 4,
      updatedAt: "2026-08-20T00:00:00.000Z",
      updatedBy: "admin@example.com",
      source: {
        type: "project",
        uri: "project://infra/prod",
        label: "Production inventory",
        observed_at: "2026-08-01T00:00:00.000Z",
      },
      observedAt: "2026-08-01T00:00:00.000Z",
      reviewedAt: "2026-08-02T00:00:00.000Z",
      reviewAfter: "2026-08-10T00:00:00.000Z",
      supersedes: ["33333333-3333-4333-8333-333333333333"],
      warnings: ["review_due"],
      markdown: "---\ntitle: Infrastructure state\n---\n\nBody",
    });

    const wrapper = mount(ProvenanceContextControl, {
      global: { plugins: [router], stubs: { Teleport: true } },
    });
    await wrapper.get('[data-testid="provenance-context-trigger"]').trigger("click");
    await flushPromises();

    expect(api).toHaveBeenCalledWith(`/api/v1/notes/${noteId}`);
    expect(wrapper.text()).toContain("Production inventory");
    expect(wrapper.text()).toContain("project://infra/prod");
    expect(wrapper.text()).toContain("review_due");
    expect(wrapper.text()).toContain("33333333-3333-4333-8333-333333333333");
    wrapper.unmount();
  });
});
