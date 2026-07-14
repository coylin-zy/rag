<script setup lang="ts">
import { Bot, LockKeyhole, Mail } from "@lucide/vue";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useAppStore } from "@web/stores/app";

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();

const email = ref("admin@coylin.com");
const password = ref("");
const errorMessage = ref("");
const submitting = ref(false);

function redirectTarget(): string {
  const requested = typeof route.query.redirect === "string" ? route.query.redirect : "";
  return requested.startsWith("/") && !requested.startsWith("//") && !requested.startsWith("/login")
    ? requested
    : "/knowledge";
}

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    await appStore.login(email.value, password.value);
    await router.replace(redirectTarget());
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败，请稍后重试";
    password.value = "";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-brand" aria-hidden="true"><Bot :size="27" /></div>
      <p class="login-eyebrow">Agent Knowledge Service</p>
      <h1 id="login-title">登录 Knowledge Core</h1>
      <p class="login-intro">使用管理员账号进入知识库管理后台。</p>

      <form class="login-form" @submit.prevent="submit">
        <div class="field">
          <label for="login-email">管理员邮箱</label>
          <div class="login-input-wrap">
            <Mail :size="17" aria-hidden="true" />
            <input
              id="login-email"
              v-model.trim="email"
              class="input login-input"
              type="email"
              autocomplete="username"
              inputmode="email"
              required
              autofocus
            >
          </div>
        </div>

        <div class="field">
          <label for="login-password">密码</label>
          <div class="login-input-wrap">
            <LockKeyhole :size="17" aria-hidden="true" />
            <input
              id="login-password"
              v-model="password"
              class="input login-input"
              type="password"
              autocomplete="current-password"
              required
            >
          </div>
        </div>

        <p v-if="errorMessage" class="login-error" role="alert">{{ errorMessage }}</p>

        <button class="button button--primary login-submit" type="submit" :disabled="submitting">
          <span v-if="submitting" class="spinner" aria-hidden="true" />
          {{ submitting ? '正在登录' : '登录' }}
        </button>
      </form>

      <p class="login-footnote">会话仅通过加密的 HttpOnly Cookie 保存，12 小时后自动过期。</p>
    </section>
  </main>
</template>
