<script setup lang="ts">
import {
  PhBookOpenText,
  PhGearSix,
  PhKey,
  PhMagnifyingGlass,
  PhRobot,
  PhShieldCheck,
  PhSignOut,
  PhStack,
  PhX,
} from "@phosphor-icons/vue";
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import { useAppStore } from "@web/stores/app";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const mobileOpen = ref(false);
const loggingOut = ref(false);

const initials = computed(() => appStore.userEmail.slice(0, 2).toUpperCase() || "KC");

const navigation = [
  { to: "/knowledge", label: "知识库", icon: PhBookOpenText },
  { to: "/search", label: "检索调试", icon: PhMagnifyingGlass },
  { to: "/proposals", label: "记忆审核", icon: PhShieldCheck },
  { to: "/tokens", label: "MCP Token", icon: PhKey },
  { to: "/jobs", label: "索引任务", icon: PhStack },
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
    <aside class="product-rail" :class="{ 'product-rail--open': mobileOpen }" aria-label="主导航">
      <div class="product-brand" data-testid="knowledge-core-brand">
        <div class="product-brand__mark" aria-hidden="true"><PhRobot :size="25" weight="duotone" /></div>
        <div class="product-brand__name"><strong>Knowledge</strong><span>Core</span></div>
        <button class="icon-button product-rail__close" type="button" aria-label="关闭导航" @click="mobileOpen = false">
          <PhX :size="20" />
        </button>
      </div>

      <nav class="product-nav">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" class="product-nav__item">
          <component :is="item.icon" :size="24" weight="regular" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="product-rail__footer">
        <div class="worker-indicator" title="Cloudflare Worker 在线"><span aria-hidden="true" />在线</div>
        <button class="rail-utility" type="button" aria-label="设置"><PhGearSix :size="21" /></button>
        <div class="rail-account">
          <div class="user-avatar">{{ initials }}</div>
          <div class="rail-account__meta"><strong>{{ appStore.userEmail || '正在验证身份' }}</strong><span>管理员</span></div>
          <button class="rail-utility" type="button" aria-label="退出登录" :disabled="loggingOut" @click="logout"><PhSignOut :size="20" /></button>
        </div>
      </div>
    </aside>

    <button v-if="mobileOpen" class="sidebar-scrim" type="button" aria-label="关闭导航" @click="mobileOpen = false" />

    <div class="workspace">
      <button class="mobile-nav-trigger" type="button" aria-label="打开导航" @click="mobileOpen = true">
        <PhRobot :size="22" weight="duotone" />
      </button>
      <main id="main-content" class="main-content" tabindex="-1">
        <div v-if="appStore.loading && !appStore.initialized" class="page-loading" aria-live="polite">
          <span class="spinner" /> 正在载入知识空间
        </div>
        <RouterView v-else />
      </main>
    </div>
  </div>
</template>
