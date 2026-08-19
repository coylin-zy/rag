<script setup lang="ts">
import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";

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
  maxRequestsPerMinute: number;
  maxWritesPerHour: number;
  lastIpPrefix: string | null;
  lastIpChangedAt: string | null;
  usageToday: {
    requests: number;
    reads: number;
    searches: number;
    proposals: number;
    writes: number;
    failures: number;
    throttles: number;
    lastUsedAt: string | null;
  };
}

interface TokenUsageResponse {
  token: {
    id: string;
    name: string;
    prefix: string;
    expiresAt: string | null;
    revokedAt: string | null;
    maxRequestsPerMinute: number;
    maxWritesPerHour: number;
    lastIpPrefix: string | null;
    lastIpChangedAt: string | null;
  };
  days: number;
  usage: Array<TokenRow["usageToday"] & { usageDate: string }>;
  anomalies: Array<{ action: string; metadataJson: string; createdAt: string }>;
}

const appStore = useAppStore();
const toast = useToastStore();
const tokens = ref<TokenRow[]>([]);
const loading = ref(false);
const showCreate = ref(false);
const creating = ref(false);
const revealedToken = ref("");
const now = ref(Date.now());
const form = ref({
  name: "",
  collectionIds: [] as string[],
  scopes: ["knowledge:read"] as string[],
  expiresAt: "",
  maxRequestsPerMinute: 60,
  maxWritesPerHour: 30,
});
const usageDialog = ref<TokenUsageResponse | null>(null);
const usageLoading = ref(false);
const emergencyRevoking = ref(false);
const configuredMcpEndpoint = import.meta.env.VITE_MCP_ENDPOINT?.trim();
const mcpEndpoint = configuredMcpEndpoint || `${window.location.origin}/mcp`;

const activeTokens = computed(() => tokens.value.filter((token) => !token.revokedAt && !(token.expiresAt && Date.parse(token.expiresAt) <= now.value)));
const adminCollections = computed(() => appStore.collections.filter((collection) => collection.role === "admin"));
const canManageGlobalAdmin = computed(() => appStore.session?.principal.bootstrapAdmin === true);
const globalAdminSelected = computed(() => form.value.scopes.includes("knowledge:admin"));
const adminExpiryHint = computed(() => {
  if (!globalAdminSelected.value) return "";
  if (!form.value.expiresAt) return "最高权限 Token 必须设置到期时间。";
  const ttl = Date.parse(form.value.expiresAt) - now.value;
  if (!Number.isFinite(ttl) || ttl < 5 * 60_000 || ttl > 7 * 24 * 60 * 60_000) return "最高权限 Token 的有效期必须在 5 分钟至 7 天内。";
  return "";
});
const canCreateToken = computed(() => form.value.scopes.length > 0 && (
  globalAdminSelected.value || form.value.collectionIds.length > 0
) && !adminExpiryHint.value);

function formatDate(value: string | null) {
  if (!value) return "从未";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function isExpired(token: TokenRow) {
  return Boolean(token.expiresAt && Date.parse(token.expiresAt) <= now.value);
}

function expiryLabel(token: TokenRow) {
  if (!token.expiresAt) return "永不过期";
  const remaining = Date.parse(token.expiresAt) - now.value;
  if (remaining <= 0) return "已过期";
  if (remaining < 60 * 60_000) return `${Math.ceil(remaining / 60_000)} 分钟后到期`;
  if (remaining < 24 * 60 * 60_000) return `${Math.ceil(remaining / (60 * 60_000))} 小时后到期`;
  return `${Math.ceil(remaining / (24 * 60 * 60_000))} 天后到期`;
}

type NumericUsageKey = Exclude<keyof TokenRow["usageToday"], "lastUsedAt">;

function usageValue(token: TokenRow, key: NumericUsageKey): number {
  return token.usageToday?.[key] ?? 0;
}

function collectionName(id: string) {
  return appStore.collections.find((item) => item.id === id)?.name ?? id.slice(0, 8);
}

function scopeName(scope: string) {
  if (scope === "knowledge:admin") return "最高知识权限";
  if (scope === "knowledge:read") return "读取与检索";
  if (scope === "memory:propose") return "记忆提案";
  return scope;
}

function hasGlobalAdmin(token: TokenRow) {
  return token.scopes.includes("knowledge:admin");
}

function localDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function toggleGlobalAdmin(checked: boolean) {
  if (checked) {
    form.value.scopes = ["knowledge:admin"];
    form.value.collectionIds = [];
    if (!form.value.expiresAt) form.value.expiresAt = localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
    return;
  }
  form.value.scopes = ["knowledge:read"];
  form.value.collectionIds = adminCollections.value.map((item) => item.id);
}

function toggleRegularScope(scope: "knowledge:read" | "memory:propose", checked: boolean) {
  const next = form.value.scopes.filter((item) => item !== "knowledge:admin" && item !== scope);
  if (checked) next.push(scope);
  form.value.scopes = next;
  if (form.value.collectionIds.length === 0) {
    form.value.collectionIds = adminCollections.value.map((item) => item.id);
  }
}

function changeGlobalAdmin(event: Event) {
  toggleGlobalAdmin((event.target as HTMLInputElement).checked);
}

function changeRegularScope(scope: "knowledge:read" | "memory:propose", event: Event) {
  toggleRegularScope(scope, (event.target as HTMLInputElement).checked);
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
  form.value = {
    name: "",
    collectionIds: adminCollections.value.map((item) => item.id),
    scopes: ["knowledge:read"],
    expiresAt: "",
    maxRequestsPerMinute: 60,
    maxWritesPerHour: 30,
  };
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
        maxRequestsPerMinute: Number(form.value.maxRequestsPerMinute),
        maxWritesPerHour: Number(form.value.maxWritesPerHour),
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

async function revokeAllKnowledgeAdminTokens() {
  if (!window.confirm("立即撤销全部最高权限 Token 吗？此操作会让连接中的 Agent 立即失去写入权限。")) return;
  emergencyRevoking.value = true;
  try {
    const result = await api<{ revokedCount: number }>("/api/v1/tokens/revoke-knowledge-admin", { method: "POST" });
    await loadTokens();
    toast.show(`已撤销 ${result.revokedCount} 个最高权限 Token`, "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "紧急撤销失败", "error");
  } finally {
    emergencyRevoking.value = false;
  }
}

async function viewUsage(token: TokenRow) {
  usageLoading.value = true;
  try {
    usageDialog.value = await api<TokenUsageResponse>(`/api/v1/tokens/${token.id}/usage?days=7`);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "用量加载失败", "error");
  } finally {
    usageLoading.value = false;
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

let refreshTimer: number | undefined;
onMounted(() => {
  void loadTokens();
  refreshTimer = window.setInterval(() => { now.value = Date.now(); }, 60_000);
});
onUnmounted(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="page-stack tokens-page">
    <div class="page-toolbar">
      <div><span class="page-eyebrow">AGENT ACCESS</span><h2>MCP 访问凭证</h2><p>按知识库和工具权限向 Agent 签发最小范围的访问令牌。</p></div>
      <div class="toolbar-actions">
        <button class="button button--secondary" type="button" :disabled="loading" @click="loadTokens"><RefreshCw :size="17" />刷新</button>
        <button v-if="canManageGlobalAdmin" data-testid="revoke-all-admin-tokens" class="button button--danger" type="button" :disabled="emergencyRevoking" @click="revokeAllKnowledgeAdminTokens"><ShieldCheck :size="17" />撤销全部最高权限</button>
        <button data-testid="create-token-trigger" class="button button--primary" type="button" :disabled="adminCollections.length === 0 && !canManageGlobalAdmin" @click="openCreate"><Plus :size="17" />创建 Token</button>
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
          <thead><tr><th>名称</th><th>知识库</th><th>权限</th><th>风控与用量</th><th>最近使用</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td data-label="名称"><div class="table-title">{{ token.name }}</div><div class="table-meta mono">{{ token.prefix }}...</div></td>
              <td data-label="知识库"><div class="tag-row"><span v-if="hasGlobalAdmin(token)" class="tag token-global-tag">所有当前和未来知识库</span><span v-for="id in token.collectionIds" v-else :key="id" class="tag">{{ collectionName(id) }}</span></div></td>
              <td data-label="权限"><div class="scope-list"><span v-for="scope in token.scopes" :key="scope" :class="{ 'scope-admin': scope === 'knowledge:admin' }"><ShieldCheck :size="13" />{{ scopeName(scope) }}</span></div></td>
              <td data-label="风控与用量"><div class="table-meta">{{ usageValue(token, "requests") }} / {{ token.maxRequestsPerMinute }} 请求/分钟</div><div class="table-meta">{{ usageValue(token, "writes") }} / {{ token.maxWritesPerHour }} 写入/小时</div><div v-if="token.lastIpPrefix" class="table-meta mono">IP {{ token.lastIpPrefix }}</div><div v-if="token.lastIpChangedAt" class="table-meta">换网 {{ formatDate(token.lastIpChangedAt) }}</div><button v-if="hasGlobalAdmin(token)" class="text-button" type="button" :disabled="usageLoading" @click="viewUsage(token)">查看 7 日用量</button></td>
              <td data-label="最近使用"><div>{{ formatDate(token.lastUsedAt) }}</div><div v-if="token.expiresAt" class="table-meta">到期 {{ formatDate(token.expiresAt) }}（{{ expiryLabel(token) }}）</div></td>
              <td data-label="状态"><span class="token-state" :class="token.revokedAt || isExpired(token) ? 'token-state--revoked' : 'token-state--active'">{{ token.revokedAt ? '已撤销' : isExpired(token) ? '已过期' : '有效' }}</span><div v-if="usageValue(token, 'throttles') > 0" class="table-meta token-risk-alert">今日限流 {{ usageValue(token, 'throttles') }} 次</div></td>
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
      <fieldset class="field"><legend class="field-label">知识库</legend><p v-if="globalAdminSelected" class="field-hint">最高权限自动覆盖所有当前和未来创建的知识库，无需逐个选择。</p><div v-else class="check-list"><label v-for="collection in adminCollections" :key="collection.id" class="check-row"><input v-model="form.collectionIds" type="checkbox" :value="collection.id" />{{ collection.name }}</label></div></fieldset>
      <fieldset class="field"><legend class="field-label">权限范围</legend><div class="check-list"><label class="check-row"><input data-testid="token-scope-read" type="checkbox" :checked="form.scopes.includes('knowledge:read')" @change="changeRegularScope('knowledge:read', $event)" />读取与检索正式知识</label><label class="check-row"><input data-testid="token-scope-propose" type="checkbox" :checked="form.scopes.includes('memory:propose')" @change="changeRegularScope('memory:propose', $event)" />提交待审核记忆</label><label v-if="canManageGlobalAdmin" class="check-row check-row--admin"><input data-testid="token-scope-admin" type="checkbox" :checked="globalAdminSelected" @change="changeGlobalAdmin" /><span><strong>最高知识权限</strong><small>允许 Agent 通过 MCP 创建、读取、修改和删除知识库与 Markdown，不允许管理 Token、成员或管理员账号。</small></span></label></div><p v-if="globalAdminSelected" class="token-admin-warning">这是高风险凭证。删除操作仍要求版本锁和名称/标题精确确认，建议设置较短有效期并仅交给受信任 Agent。</p></fieldset>
      <div class="field"><label for="token-expiry">到期时间</label><input id="token-expiry" v-model="form.expiresAt" class="input" type="datetime-local" :required="globalAdminSelected" /><p class="field-hint">普通 Token 可留空；最高权限必须在 5 分钟至 7 天内过期。</p><p v-if="adminExpiryHint" class="form-error">{{ adminExpiryHint }}</p></div>
      <div class="form-row"><div class="field"><label for="token-request-limit">请求限额</label><input id="token-request-limit" v-model.number="form.maxRequestsPerMinute" class="input" type="number" min="1" max="600" required /><p class="field-hint">每分钟最多请求数，默认 60。</p></div><div class="field"><label for="token-write-limit">写入限额</label><input id="token-write-limit" v-model.number="form.maxWritesPerHour" class="input" type="number" min="1" max="1000" required /><p class="field-hint">每小时最多写操作数，默认 30。</p></div></div>
    </form>
    <template #footer><button class="button button--secondary" type="button" @click="showCreate = false">取消</button><button class="button button--primary" type="submit" form="token-form" :disabled="creating || !canCreateToken"><span v-if="creating" class="spinner" />创建</button></template>
  </ModalDialog>

  <ModalDialog v-if="revealedToken" title="Token 已创建" description="关闭后将无法再次查看完整值。" @close="revealedToken = ''">
    <div class="token-reveal"><code>{{ revealedToken }}</code><button class="button button--primary" type="button" @click="copyValue(revealedToken)"><Copy :size="17" />复制 Token</button></div>
    <template #footer><button class="button button--secondary" type="button" @click="revealedToken = ''">我已保存</button></template>
  </ModalDialog>

  <ModalDialog v-if="usageDialog" title="Token 用量与异常" :description="`${usageDialog.token.name} · 最近 ${usageDialog.days} 天`" wide @close="usageDialog = null">
    <div class="usage-summary stat-strip"><div><span>请求</span><strong>{{ usageDialog.usage.reduce((total, day) => total + day.requests, 0) }}</strong></div><div><span>写入</span><strong>{{ usageDialog.usage.reduce((total, day) => total + day.writes, 0) }}</strong></div><div><span>失败</span><strong>{{ usageDialog.usage.reduce((total, day) => total + day.failures, 0) }}</strong></div><div><span>限流</span><strong>{{ usageDialog.usage.reduce((total, day) => total + day.throttles, 0) }}</strong></div></div>
    <div v-if="usageDialog.usage.length" class="data-table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>请求</th><th>读取</th><th>检索</th><th>提案</th><th>写入</th><th>失败</th><th>限流</th></tr></thead><tbody><tr v-for="day in usageDialog.usage" :key="day.usageDate"><td>{{ day.usageDate }}</td><td>{{ day.requests }}</td><td>{{ day.reads }}</td><td>{{ day.searches }}</td><td>{{ day.proposals }}</td><td>{{ day.writes }}</td><td>{{ day.failures }}</td><td>{{ day.throttles }}</td></tr></tbody></table></div><p v-else class="field-hint">最近 7 天没有记录。</p>
    <div v-if="usageDialog.anomalies.length" class="usage-anomalies"><h4>最近审计提醒</h4><div v-for="item in usageDialog.anomalies" :key="`${item.action}-${item.createdAt}`"><span>{{ item.action }}</span><time>{{ formatDate(item.createdAt) }}</time></div></div>
    <template #footer><button class="button button--secondary" type="button" @click="usageDialog = null">关闭</button></template>
  </ModalDialog>
</template>
