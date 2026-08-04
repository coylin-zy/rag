<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import AppShell from "./components/AppShell.vue";
import ToastHost from "./components/ToastHost.vue";
import { ApiClientError } from "./lib/api";
import { useAppStore } from "./stores/app";
import { useToastStore } from "./stores/toast";

const appStore = useAppStore();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();
const authLayout = computed(() => route.meta.layout === "auth");

async function ensureSession() {
  if (route.name === "login" || authLayout.value || appStore.initialized || appStore.loading || appStore.initializationError) return;
  try {
    await appStore.initialize();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      appStore.reset();
      await router.replace({ name: "login", query: { redirect: route.fullPath } });
      return;
    }
    toast.show(error instanceof Error ? error.message : "初始化失败", "error");
  }
}

onMounted(ensureSession);
watch(() => route.fullPath, ensureSession);
</script>

<template>
  <RouterView v-if="authLayout" />
  <template v-else>
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <AppShell />
  </template>
  <ToastHost />
</template>
