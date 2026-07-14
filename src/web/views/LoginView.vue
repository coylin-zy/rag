<script setup lang="ts">
import { PhBookOpenText, PhCheckCircle, PhEnvelopeSimple, PhLockKey, PhRobot } from "@phosphor-icons/vue";
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
    <section class="login-context" aria-label="产品介绍">
      <div class="login-context__brand">
        <span class="login-context__mark"><PhRobot :size="30" weight="duotone" /></span>
        <span><strong>Knowledge Core</strong><small>Agent knowledge service</small></span>
      </div>
      <div class="login-context__copy">
        <p class="login-eyebrow">AI KNOWLEDGE OPERATIONS</p>
        <h1>让 Agent 记住<br>真正可信的知识。</h1>
        <p>在一个工作区内维护 Markdown、审核记忆、验证检索，并通过 MCP 安全交付给 Codex 与其他 Agent。</p>
      </div>
      <div class="login-context__flow" aria-label="知识流程">
        <span><PhBookOpenText :size="18" />组织 Markdown</span>
        <span><PhCheckCircle :size="18" />人工审核</span>
        <span><PhRobot :size="18" />连接 Agent</span>
      </div>
      <p class="login-context__foot">R2 原文存储 · D1 元数据 · Vectorize 检索</p>
    </section>

    <section class="login-form-panel" aria-labelledby="login-title">
      <div class="login-form-panel__inner">
        <p class="login-eyebrow">管理员入口</p>
        <h2 id="login-title">欢迎回来</h2>
        <p class="login-intro">登录后继续维护 Agent 的长期知识。</p>

        <form class="login-form" @submit.prevent="submit">
          <div class="field">
            <label for="login-email">管理员邮箱</label>
            <div class="login-input-wrap">
              <PhEnvelopeSimple :size="19" aria-hidden="true" />
              <input id="login-email" v-model.trim="email" class="input login-input" type="email" autocomplete="username" inputmode="email" required autofocus>
            </div>
          </div>

          <div class="field">
            <div class="field-heading"><label for="login-password">密码</label><span>12 小时安全会话</span></div>
            <div class="login-input-wrap">
              <PhLockKey :size="19" aria-hidden="true" />
              <input id="login-password" v-model="password" class="input login-input" type="password" autocomplete="current-password" required>
            </div>
          </div>

          <p v-if="errorMessage" class="login-error" role="alert">{{ errorMessage }}</p>

          <button class="button button--primary login-submit" type="submit" :disabled="submitting">
            <span v-if="submitting" class="spinner" aria-hidden="true" />
            {{ submitting ? '正在验证' : '进入知识工作区' }}
          </button>
        </form>

        <p class="login-footnote">凭据只发送到你的 Cloudflare Worker，会话通过加密的 HttpOnly Cookie 保存。</p>
      </div>
    </section>
  </main>
</template>
