<script setup lang="ts">
import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";

import ModalDialog from "@web/components/ModalDialog.vue";
import { api, jsonBody } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import { useToastStore } from "@web/stores/toast";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  collectionIds: string[];
  scopes: string[];
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const appStore = useAppStore();
const toast = useToastStore();
const tokens = ref<TokenRow[]>([]);
const loading = ref(false);
const showCreate = ref(false);
const creating = ref(false);
const revealedToken = ref("");
const form = ref({ name: "", collectionIds: [] as string[], scopes: ["knowledge:read"] as string[], expiresAt: "" });
const configuredMcpEndpoint = import.meta.env.VITE_MCP_ENDPOINT?.trim();
const mcpEndpoint = configuredMcpEndpoint || `${window.location.origin}/mcp`;

const activeTokens = computed(() => tokens.value.filter((token) => !token.revokedAt));
const adminCollections = computed(() => appStore.collections.filter((collection) => collection.role === "admin"));

function formatDate(value: string | null) {
  if (!value) return "从未";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function collectionName(id: string) {
  return appStore.collections.find((item) => item.id === id)?.name ?? id.slice(0, 8);
}

async function loadTokens() {
  loading.value = true;
  try {
    tokens.value = await api<TokenRow[]>("/api/v1/tokens");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "Token 加载失败", "error");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { name: "", collectionIds: adminCollections.value.map((item) => item.id), scopes: ["knowledge:read"], expiresAt: "" };
  showCreate.value = true;
}

async function createNewToken() {
  creating.value = true;
  try {
    const created = await api<TokenRow & { token: string }>("/api/v1/tokens", {
      method: "POST",
      ...jsonBody({
        ...form.value,
        expiresAt: form.value.expiresAt ? new Date(form.value.expiresAt).toISOString() : null,
      }),
    });
    revealedToken.value = created.token;
    showCreate.value = false;
    await loadTokens();
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "Token 创建失败", "error");
  } finally {
    creating.value = false;
  }
}

async function revoke(id: string, name: string) {
  if (!window.confirm(`撤销 Token“${name}”吗？连接它的 Agent 将立即失去访问权限。`)) return;
  try {
    await api(`/api/v1/tokens/${id}`, { method: "DELETE" });
    await loadTokens();
    toast.show("Token 已撤销", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "撤销失败", "error");
  }
}

async function copyValue(value: string) {
  await navigator.clipboard.writeText(value);
  toast.show("已复制到剪贴板", "success");
}

onMounted(loadTokens);
</script>

<template>
  <div class="page-stack tokens-page">
    <div class="page-toolbar">
      <div><span class="page-eyebrow">AGENT ACCESS</span><h2>MCP 访问凭证</h2><p>按知识库和工具权限向 Agent 签发最小范围的访问令牌。</p></div>
      <div class="toolbar-actions">
        <button class="button button--secondary" type="button" :disabled="loading" @click="loadTokens"><RefreshCw :size="17" />刷新</button>
        <button class="button button--primary" type="button" :disabled="adminCollections.length === 0" @click="openCreate"><Plus :size="17" />创建 Token</button>
      </div>
    </div>

    <div class="endpoint-band">
      <div><span>MCP Endpoint</span><strong class="mono">{{ mcpEndpoint }}</strong></div>
      <button class="icon-button" type="button" title="复制 MCP Endpoint" aria-label="复制 MCP Endpoint" @click="copyValue(mcpEndpoint)"><Copy :size="17" /></button>
    </div>

    <section class="surface">
      <div class="section-header"><div><h3>有效 Token</h3><p>{{ activeTokens.length }} 个可用凭证</p></div></div>
      <div v-if="loading" class="page-loading"><span class="spinner" />载入 Token</div>
      <div v-else-if="tokens.length === 0" class="empty-state"><div><div class="empty-state-icon"><KeyRound :size="22" /></div><h3>还没有 MCP Token</h3><p>创建 Token 后即可把受限知识库连接到 Codex 或其他 MCP 客户端。</p></div></div>
      <div v-else class="data-table-wrap data-table-wrap--cards">
        <table class="data-table data-table--cards">
          <thead><tr><th>名称</th><th>知识库</th><th>权限</th><th>最近使用</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td data-label="名称"><div class="table-title">{{ token.name }}</div><div class="table-meta mono">{{ token.prefix }}...</div></td>
              <td data-label="知识库"><div class="tag-row"><span v-for="id in token.collectionIds" :key="id" class="tag">{{ collectionName(id) }}</span></div></td>
              <td data-label="权限"><div class="scope-list"><span v-for="scope in token.scopes" :key="scope"><ShieldCheck :size="13" />{{ scope }}</span></div></td>
              <td data-label="最近使用"><div>{{ formatDate(token.lastUsedAt) }}</div><div v-if="token.expiresAt" class="table-meta">到期 {{ formatDate(token.expiresAt) }}</div></td>
              <td data-label="状态"><span class="token-state" :class="token.revokedAt ? 'token-state--revoked' : 'token-state--active'">{{ token.revokedAt ? '已撤销' : '有效' }}</span></td>
              <td data-label="操作"><div class="table-actions"><button class="icon-button icon-button--small" type="button" title="撤销 Token" aria-label="撤销 Token" :disabled="Boolean(token.revokedAt)" @click="revoke(token.id, token.name)"><Trash2 :size="16" /></button></div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <ModalDialog v-if="showCreate" title="创建 MCP Token" description="Token 只显示一次，并按所选知识库和权限生效。" @close="showCreate = false">
    <form id="token-form" class="form-grid" @submit.prevent="createNewToken">
      <div class="field"><label for="token-name">名称</label><input id="token-name" v-model="form.name" class="input" required maxlength="80" placeholder="Codex 主工作区" autofocus /></div>
      <fieldset class="field"><legend class="field-label">知识库</legend><div class="check-list"><label v-for="collection in adminCollections" :key="collection.id" class="check-row"><input v-model="form.collectionIds" type="checkbox" :value="collection.id" />{{ collection.name }}</label></div></fieldset>
      <fieldset class="field"><legend class="field-label">权限范围</legend><div class="check-list"><label class="check-row"><input v-model="form.scopes" type="checkbox" value="knowledge:read" />读取与检索正式知识</label><label class="check-row"><input v-model="form.scopes" type="checkbox" value="memory:propose" />提交待审核记忆</label></div></fieldset>
      <div class="field"><label for="token-expiry">到期时间</label><input id="token-expiry" v-model="form.expiresAt" class="input" type="datetime-local" /><p class="field-hint">留空表示不自动过期。</p></div>
    </form>
    <template #footer><button class="button button--secondary" type="button" @click="showCreate = false">取消</button><button class="button button--primary" type="submit" form="token-form" :disabled="creating || form.collectionIds.length === 0 || form.scopes.length === 0"><span v-if="creating" class="spinner" />创建</button></template>
  </ModalDialog>

  <ModalDialog v-if="revealedToken" title="Token 已创建" description="关闭后将无法再次查看完整值。" @close="revealedToken = ''">
    <div class="token-reveal"><code>{{ revealedToken }}</code><button class="button button--primary" type="button" @click="copyValue(revealedToken)"><Copy :size="17" />复制 Token</button></div>
    <template #footer><button class="button button--secondary" type="button" @click="revealedToken = ''">我已保存</button></template>
  </ModalDialog>
</template>
