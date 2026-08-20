<script setup lang="ts">
import { PhBookOpenText } from "@phosphor-icons/vue";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

import type { NoteSummary } from "@shared/contracts";
import ModalDialog from "@web/components/ModalDialog.vue";
import { api } from "@web/lib/api";
import { useToastStore } from "@web/stores/toast";

interface NoteDetail extends NoteSummary { markdown: string }

const route = useRoute();
const toast = useToastStore();
const open = ref(false);
const loading = ref(false);
const detail = ref<NoteDetail | null>(null);
const noteId = computed(() => typeof route.params.noteId === "string" ? route.params.noteId : "");

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function show() {
  if (!noteId.value) return;
  open.value = true;
  loading.value = true;
  try {
    detail.value = await api<NoteDetail>(`/api/v1/notes/${noteId.value}`);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "来源信息加载失败", "error");
    open.value = false;
  } finally {
    loading.value = false;
  }
}

watch(noteId, () => {
  open.value = false;
  detail.value = null;
});
</script>

<template>
  <button
    v-if="noteId"
    class="rail-utility"
    type="button"
    title="文档来源与时效"
    aria-label="文档来源与时效"
    data-testid="provenance-context-trigger"
    @click="show"
  ><PhBookOpenText :size="21" /></button>

  <ModalDialog v-if="open" title="来源与知识时效" :description="detail?.title || '正在读取文档上下文'" @close="open = false">
    <div v-if="loading" class="page-loading"><span class="spinner" />正在读取来源信息</div>
    <div v-else-if="detail" class="provenance-context">
      <p v-if="detail.warnings?.includes('review_due')" class="provenance-warning"><strong>review_due</strong>：这条知识已经超过复核期限，使用前应重新验证当前事实。</p>
      <dl>
        <div><dt>来源类型</dt><dd>{{ detail.source?.type || '未声明' }}</dd></div>
        <div><dt>来源标签</dt><dd>{{ detail.source?.label || '—' }}</dd></div>
        <div><dt>来源 URI</dt><dd class="mono">{{ detail.source?.uri || '—' }}</dd></div>
        <div><dt>观察时间</dt><dd>{{ formatDate(detail.observedAt) }}</dd></div>
        <div><dt>最近人工复核</dt><dd>{{ formatDate(detail.reviewedAt) }}</dd></div>
        <div><dt>下次复核</dt><dd>{{ formatDate(detail.reviewAfter) }}</dd></div>
        <div><dt>替代关系</dt><dd>{{ detail.supersedes?.length ? detail.supersedes.join(', ') : '—' }}</dd></div>
        <div><dt>当前版本</dt><dd>v{{ detail.version }}</dd></div>
      </dl>
      <p class="field-hint">人工复核请在“待复核知识”工作区完成；直接编辑 Markdown 或 Agent 写入不能伪造 <code>reviewed_at</code>。</p>
    </div>
  </ModalDialog>
</template>

<style scoped>
.provenance-context { display: grid; gap: 14px; }
.provenance-context dl { display: grid; gap: 0; margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.provenance-context dl div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.provenance-context dl div:last-child { border-bottom: 0; }
.provenance-context dt { color: var(--text-muted); font-size: 11px; }
.provenance-context dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.provenance-warning { margin: 0; padding: 10px 12px; color: #815000; background: #fff6dc; border: 1px solid #ecd49e; border-radius: 8px; font-size: 12px; line-height: 1.6; }
@media (max-width: 640px) {
  .provenance-context dl div { grid-template-columns: 1fr; gap: 4px; }
}
</style>
