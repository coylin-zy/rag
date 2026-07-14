<script setup lang="ts">
import {
  BookOpenText,
  Bot,
  DatabaseZap,
  KeyRound,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import { useAppStore } from "@web/stores/app";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const mobileOpen = ref(false);
const loggingOut = ref(false);

const pageTitle = computed(() => String(route.meta.title ?? "Knowledge Core"));
const initials = computed(() => appStore.userEmail.slice(0, 2).toUpperCase() || "KC");

const navigation = [
  { to: "/knowledge", label: "知识库", icon: BookOpenText },
  { to: "/search", label: "检索调试", icon: Search },
  { to: "/proposals", label: "记忆审核", icon: ShieldCheck },
  { to: "/tokens", label: "MCP Token", icon: KeyRound },
  { to: "/jobs", label: "索引任务", icon: DatabaseZap },
];

async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await appStore.logout();
    await router.replace({ name: "login" });
  } finally {
    loggingOut.value = false;
  }
}

watch(() => route.fullPath, async () => {
  mobileOpen.value = false;
  await nextTick();
  document.getElementById("main-content")?.focus();
});
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ 'sidebar--open': mobileOpen }" aria-label="主导航">
      <div class="brand-block">
        <div class="brand-mark" aria-hidden="true"><Bot :size="20" /></div>
        <div>
          <strong>Knowledge Core</strong>
          <span>Agent knowledge service</span>
        </div>
        <button class="icon-button sidebar-close" type="button" aria-label="关闭导航" @click="mobileOpen = false">
          <X :size="20" />
        </button>
      </div>

      <nav class="nav-list">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" class="nav-item">
          <component :is="item.icon" :size="19" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="user-avatar">{{ initials }}</div>
        <div class="user-meta">
          <strong>{{ appStore.userEmail || '正在验证身份' }}</strong>
          <span>HTTPS 管理会话</span>
        </div>
        <button
          class="icon-button sidebar-logout"
          type="button"
          aria-label="退出登录"
          :disabled="loggingOut"
          @click="logout"
        >
          <LogOut :size="18" />
        </button>
      </div>
    </aside>

    <button v-if="mobileOpen" class="sidebar-scrim" type="button" aria-label="关闭导航" @click="mobileOpen = false" />

    <div class="workspace">
      <header class="topbar">
        <button class="icon-button menu-button" type="button" aria-label="打开导航" @click="mobileOpen = true">
          <Menu :size="21" />
        </button>
        <div>
          <p class="topbar-kicker">Agent Knowledge</p>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="service-state"><span aria-hidden="true" /> Worker 在线</div>
      </header>

      <main id="main-content" class="main-content" tabindex="-1">
        <div v-if="appStore.loading && !appStore.initialized" class="page-loading" aria-live="polite">
          <span class="spinner" /> 正在载入知识空间
        </div>
        <RouterView v-else />
      </main>
    </div>
  </div>
</template>
