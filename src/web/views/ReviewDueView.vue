<script setup lang="ts">
import { PhArrowSquareOut, PhCheckCircle, PhClockCountdown, PhWarningCircle } from "@phosphor-icons/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import type { SourceMetadata } from "@shared/contracts";
import ModalDialog from "@web/components/ModalDialog.vue";
import { api, jsonBody } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import { useToastStore } from "@web/stores/toast";

interface ReviewDueItem {
  id: string;
  collectionId: string;
  title: string;
  version: number;
  source: SourceMetadata | null;
  observedAt: string | null;
  reviewedAt: string | null;
  reviewAfter: string;
  warnings: ["review_due"];
}

const appStore = useAppStore();
const toast = useToastStore();
const router = useRouter();
const selectedCollectionId = ref("");
const items = ref<ReviewDueItem[]>([]);
const loading = ref(false);
const reviewing = ref(false);
const selectedItem = ref<ReviewDueItem | null>(null);
const nextReviewDate = ref("");

const selectedCollection = computed(() => appStore.collections.find((collection) => collection.id === selectedCollectionId.value) ?? null);
const canReview = computed(() => selectedCollection.value?.role === "admin" || selectedCollection.value?.role === "editor");

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sourceLabel(source: SourceMetadata | null) {
  if (!source) return "未声明来源";
  return source.label || source.uri || source.type;
}

function defaultNextReviewDate() {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

async function loadDue() {
  if (!selectedCollectionId.value) {
    items.value = [];
    return;
  }
  loading.value = true;
  try {
    items.value = await api<ReviewDueItem[]>(`/api/v1/collections/${selectedCollectionId.value}/review-due?limit=200`);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "待复核知识加载失败", "error");
  } finally {
    loading.value = false;
  }
}

function openReview(item: ReviewDueItem) {
  if (!canReview.value) return;
  selectedItem.value = item;
  nextReviewDate.value = defaultNextReviewDate();
}

function closeReview() {
  if (reviewing.value) return;
  selectedItem.value = null;
  nextReviewDate.value = "";
}

async function confirmReview() {
  const item = selectedItem.value;
  if (!item || reviewing.value) return;
  reviewing.value = true;
  try {
    const nextReviewAfter = nextReviewDate.value
      ? new Date(`${nextReviewDate.value}T23:59:59.999Z`).toISOString()
      : null;
    await api(`/api/v1/notes/${item.id}/review`, {
      method: "POST",
      headers: { "if-match": `"${item.version}"` },
      ...jsonBody({ nextReviewAfter }),
    });
    closeReview();
    await loadDue();
    toast.show("已记录人工复核并创建新版本", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "复核失败，请刷新后重试", "error");
  } finally {
    reviewing.value = false;
  }
}

async function openNote(item: ReviewDueItem) {
  await router.push(`/knowledge/${item.collectionId}/notes/${item.id}`);
}

watch(selectedCollectionId, loadDue);

onMounted(() => {
  selectedCollectionId.value = appStore.collections[0]?.id ?? "";
});
</script>

<template>
  <section class="page-stack review-due-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">Knowledge governance</p>
        <h1>待复核知识</h1>
        <p>到期知识仍可被检索，但 Agent 会收到 <code>review_due</code> 警告。人工复核会生成新的不可变版本。</p>
      </div>
      <label class="review-due-collection">
        <span>知识库</span>
        <select v-model="selectedCollectionId" class="select">
          <option v-for="collection in appStore.collections" :key="collection.id" :value="collection.id">{{ collection.name }}</option>
        </select>
      </label>
    </header>

    <div class="summary-strip">
      <div><PhWarningCircle :size="20" weight="duotone" /><span>需要复核</span><strong>{{ items.length }}</strong></div>
      <div><PhClockCountdown :size="20" weight="duotone" /><span>判断规则</span><strong>review_after &lt; now</strong></div>
      <div><PhCheckCircle :size="20" weight="duotone" /><span>当前权限</span><strong>{{ canReview ? '可复核' : '只读' }}</strong></div>
    </div>

    <div v-if="loading" class="page-loading"><span class="spinner" />正在读取待复核知识</div>
    <div v-else-if="!selectedCollectionId" class="empty-state">暂无知识库。</div>
    <div v-else-if="items.length === 0" class="empty-state">当前知识库没有到期知识。</div>
    <div v-else class="review-due-list">
      <article v-for="item in items" :key="item.id" class="review-due-card">
        <div class="review-due-card__main">
          <div class="review-due-card__title">
            <span class="warning-pill">review_due</span>
            <h2>{{ item.title }}</h2>
          </div>
          <dl>
            <div><dt>来源</dt><dd>{{ sourceLabel(item.source) }}</dd></div>
            <div><dt>观察时间</dt><dd>{{ formatDate(item.observedAt) }}</dd></div>
            <div><dt>最近人工复核</dt><dd>{{ formatDate(item.reviewedAt) }}</dd></div>
            <div><dt>复核期限</dt><dd>{{ formatDate(item.reviewAfter) }}</dd></div>
            <div><dt>版本</dt><dd>v{{ item.version }}</dd></div>
          </dl>
        </div>
        <div class="review-due-card__actions">
          <button class="button button--secondary" type="button" @click="openNote(item)"><PhArrowSquareOut :size="16" />打开文档</button>
          <button class="button button--primary" type="button" :disabled="!canReview" @click="openReview(item)"><PhCheckCircle :size="16" />标记已复核</button>
        </div>
      </article>
    </div>
  </section>

  <ModalDialog v-if="selectedItem" title="标记已复核" :description="selectedItem.title" @close="closeReview">
    <div class="form-grid">
      <p class="field-hint">本操作会把当前时间写入 <code>reviewed_at</code>，并创建 v{{ selectedItem.version + 1 }}。Agent 不能执行这个人工复核操作。</p>
      <div class="field">
        <label for="next-review-date">下一次复核日期</label>
        <input id="next-review-date" v-model="nextReviewDate" class="input" type="date" />
        <p class="field-hint">留空表示不再设置复核期限。</p>
      </div>
    </div>
    <template #footer>
      <button class="button button--secondary" type="button" :disabled="reviewing" @click="closeReview">取消</button>
      <button class="button button--primary" type="button" :disabled="reviewing" @click="confirmReview"><span v-if="reviewing" class="spinner" />确认复核</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.review-due-page { padding: 28px; }
.review-due-collection { min-width: 240px; display: grid; gap: 7px; font-size: 12px; color: var(--text-muted); }
.review-due-list { display: grid; gap: 12px; }
.review-due-card { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
.review-due-card__main { min-width: 0; flex: 1; }
.review-due-card__title { display: flex; align-items: center; gap: 10px; }
.review-due-card__title h2 { margin: 0; font-size: 16px; }
.warning-pill { padding: 3px 7px; color: #8a4f00; background: #fff4d8; border: 1px solid #efd59d; border-radius: 999px; font-size: 10px; font-weight: 750; }
.review-due-card dl { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 14px 0 0; }
.review-due-card dl div { min-width: 0; }
.review-due-card dt { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.review-due-card dd { margin: 4px 0 0; font-size: 12px; overflow-wrap: anywhere; }
.review-due-card__actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 900px) {
  .review-due-page { padding: 18px 14px 90px; }
  .review-due-card { align-items: stretch; flex-direction: column; }
  .review-due-card dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .review-due-card__actions .button { flex: 1; }
}
</style>
