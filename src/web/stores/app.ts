import { defineStore } from "pinia";
import { computed, ref } from "vue";

import type { CollectionSummary } from "@shared/contracts";
import { api } from "@web/lib/api";

interface Session {
  principal: { email: string; subject: string; bootstrapAdmin: boolean };
}

export const useAppStore = defineStore("app", () => {
  const session = ref<Session | null>(null);
  const collections = ref<CollectionSummary[]>([]);
  const loading = ref(false);
  const initialized = ref(false);

  const userEmail = computed(() => session.value?.principal.email ?? "");
  const pendingCollections = computed(() => collections.value.filter((item) => item.noteCount === 0).length);

  async function loadCollections() {
    collections.value = await api<CollectionSummary[]>("/api/v1/collections");
  }

  async function initialize() {
    if (loading.value) return;
    loading.value = true;
    try {
      const [sessionResult, collectionsResult] = await Promise.all([
        api<Session>("/api/v1/session"),
        api<CollectionSummary[]>("/api/v1/collections"),
      ]);
      session.value = sessionResult;
      collections.value = collectionsResult;
      initialized.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function login(email: string, password: string) {
    if (loading.value) return;
    loading.value = true;
    try {
      session.value = await api<Session>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      collections.value = await api<CollectionSummary[]>("/api/v1/collections");
      initialized.value = true;
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    session.value = null;
    collections.value = [];
    initialized.value = false;
    loading.value = false;
  }

  async function logout() {
    try {
      await api<{ loggedOut: boolean }>("/api/v1/auth/logout", { method: "POST" });
    } finally {
      reset();
    }
  }

  return {
    session,
    collections,
    loading,
    initialized,
    userEmail,
    pendingCollections,
    initialize,
    loadCollections,
    login,
    logout,
    reset,
  };
});
