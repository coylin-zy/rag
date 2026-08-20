<script setup lang="ts">
import {
  PhArrowClockwise,
  PhBookOpenText,
  PhGearSix,
  PhKey,
  PhMagnifyingGlass,
  PhRobot,
  PhShieldCheck,
  PhSignOut,
  PhStack,
  PhWarningCircle,
  PhX,
} from "@phosphor-icons/vue";
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import ModalDialog from "@web/components/ModalDialog.vue";
import { ApiClientError } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const mobileOpen = ref(false);
const loggingOut = ref(false);
const retryingInitialization = ref(false);
const showSettings = ref(false);

const initials = computed(() => appStore.userEmail.slice(0, 2).toUpperCase() || "KC");
const configuredMcpEndpoint = import.meta.env.VITE_MCP_ENDPOINT?.trim();
const mcpEndpoint = configuredMcpEndpoint || `${window.location.origin}/mcp`;

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

async function retryInitialization() {
  if (retryingInitialization.value) return;
  retryingInitialization.value = true;
  try {
    await appStore.initialize();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      appStore.reset();
      await router.replace({ name: "login", query: { redirect: route.fullPath } });
    }
  } finally {
    retryingInitialization.value = false;
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
        <RouterLink
          v-if="typeof route.params.collectionId === 'string' && typeof route.params.noteId === 'string'"
          :to="`/knowledge/${route.params.collectionId}/notes/${route.params.noteId}/versions`"
          class="product-nav__item"
          data-testid="version-diff-nav"
        >
          <PhArrowClockwise :size="24" weight="regular" />
          <span>版本对比</span>
        </RouterLink>
      </nav>

      <div class="product-rail__footer">
        <RouterLink class="rail-utility" to="/review-due" title="待复核知识" aria-label="待复核知识" data-testid="review-due-nav"><PhWarningCircle :size="21" /></RouterLink>
        <div class="worker-indicator" :class="{ 'worker-indicator--offline': appStore.initializationError }" :title="appStore.initialized ? 'Cloudflare Worker 在线' : appStore.initializationError ? 'Cloudflare Worker 连接失败' : '正在连接 Cloudflare Worker'">
          <span aria-hidden="true" />{{ appStore.initialized ? '在线' : appStore.initializationError ? '连接失败' : '连接中' }}
        </div>
        <button class="rail-utility" type="button" aria-label="设置" data-testid="workspace-settings-trigger" @click="showSettings = true"><PhGearSix :size="21" /></button>
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
        <div v-if="!appStore.initialized" class="page-loading initialization-state" :role="appStore.initializationError ? 'alert' : 'status'" aria-live="polite">
          <template v-if="appStore.initializationError">
            <PhWarningCircle :size="30" weight="duotone" aria-hidden="true" />
            <h2>知识空间暂时无法载入</h2>
            <p>{{ appStore.initializationError.message }}</p>
            <button class="button button--primary" type="button" data-testid="initialization-retry" :disabled="retryingInitialization" @click="retryInitialization">
              <span v-if="retryingInitialization" class="spinner" />
              <PhArrowClockwise v-else :size="17" />
              重新连接
            </button>
            <small>错误代码：{{ appStore.initializationError.code }}</small>
          </template>
          <template v-else>
            <span class="spinner" /> 正在载入知识空间
          </template>
        </div>
        <RouterView v-else />
      </main>
    </div>
  </div>

  <ModalDialog v-if="showSettings" title="工作区信息" description="当前连接与 Agent 接入信息（只读）。" @close="showSettings = false">
    <dl class="settings-summary">
      <div><dt>管理员</dt><dd>{{ appStore.userEmail || '会话尚未建立' }}</dd></div>
      <div><dt>会话状态</dt><dd><span class="settings-status" :class="{ 'settings-status--online': appStore.initialized }" />{{ appStore.initialized ? '已连接' : '未连接' }}</dd></div>
      <div><dt>知识库</dt><dd>{{ appStore.collections.length }} 个</dd></div>
      <div><dt>MCP Endpoint</dt><dd class="mono settings-endpoint">{{ mcpEndpoint }}</dd></div>
    </dl>
    <template #footer><button class="button button--primary" type="button" @click="showSettings = false">完成</button></template>
  </ModalDialog>
</template>