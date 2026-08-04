import { defineStore } from "pinia";
import { computed, ref } from "vue";

import type { CollectionSummary } from "@shared/contracts";
import { api, ApiClientError } from "@web/lib/api";

interface Session {
  principal: { email: string; subject: string; bootstrapAdmin: boolean };
}

interface InitializationError {
  message: string;
  code: string;
  status: number | null;
}

export const useAppStore = defineStore("app", () => {
  const session = ref<Session | null>(null);
  const collections = ref<CollectionSummary[]>([]);
  const loading = ref(false);
  const initialized = ref(false);
  const initializationError = ref<InitializationError | null>(null);

  const userEmail = computed(() => session.value?.principal.email ?? "");
  const pendingCollections = computed(() => collections.value.filter((item) => item.noteCount === 0).length);

  async function loadCollections() {
    collections.value = await api<CollectionSummary[]>("/api/v1/collections");
  }

  async function initialize() {
    if (loading.value) return;
    loading.value = true;
    initializationError.value = null;
    try {
      const [sessionResult, collectionsResult] = await Promise.all([
        api<Session>("/api/v1/session"),
        api<CollectionSummary[]>("/api/v1/collections"),
      ]);
      session.value = sessionResult;
      collections.value = collectionsResult;
      initialized.value = true;
    } catch (error) {
      session.value = null;
      collections.value = [];
      initialized.value = false;
      initializationError.value = {
        message: error instanceof Error ? error.message : "知识空间初始化失败",
        code: error instanceof ApiClientError ? error.code : "initialization_failed",
        status: error instanceof ApiClientError ? error.status : null,
      };
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function login(email: string, password: string) {
    if (loading.value) return;
    loading.value = true;
    initializationError.value = null;
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
    initializationError.value = null;
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
    initializationError,
    userEmail,
    pendingCollections,
    initialize,
    loadCollections,
    login,
    logout,
    reset,
  };
});
