<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Clock3, DatabaseZap, RefreshCw, RotateCcw } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import StatusBadge from "@web/components/StatusBadge.vue";
import { api } from "@web/lib/api";
import { useToastStore } from "@web/stores/toast";

interface JobRow {
  id: string;
  noteId: string;
  version: number | null;
  type: "index" | "delete";
  status: "queued" | "processing" | "ready" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const toast = useToastStore();
const jobs = ref<JobRow[]>([]);
const loading = ref(false);
const filter = ref<"all" | JobRow["status"]>("all");
let pollHandle: number | undefined;

const filtered = computed(() => filter.value === "all" ? jobs.value : jobs.value.filter((job) => job.status === filter.value));
const stats = computed(() => ({
  active: jobs.value.filter((job) => job.status === "queued" || job.status === "processing").length,
  ready: jobs.value.filter((job) => job.status === "ready").length,
  failed: jobs.value.filter((job) => job.status === "failed").length,
}));

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

async function loadJobs(silent = false) {
  if (!silent) loading.value = true;
  try {
    jobs.value = await api<JobRow[]>("/api/v1/jobs");
  } catch (error) {
    if (!silent) toast.show(error instanceof Error ? error.message : "任务加载失败", "error");
  } finally {
    loading.value = false;
  }
}

async function retry(jobId: string) {
  try {
    await api(`/api/v1/jobs/${jobId}/retry`, { method: "POST" });
    await loadJobs(true);
    toast.show("任务已重新排队", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "重试失败", "error");
  }
}

onMounted(() => {
  void loadJobs();
  pollHandle = window.setInterval(() => void loadJobs(true), 10_000);
});
onBeforeUnmount(() => window.clearInterval(pollHandle));
</script>

<template>
  <div class="page-stack jobs-page">
    <div class="page-toolbar">
      <div><span class="page-eyebrow">INDEX PIPELINE</span><h2>索引任务</h2><p>观察 Markdown 切块、Embedding、Vectorize 写入和清理状态。</p></div>
      <div class="toolbar-actions"><button class="button button--secondary" type="button" :disabled="loading" @click="loadJobs()"><RefreshCw :size="17" />刷新</button></div>
    </div>

    <div class="stat-strip" aria-label="任务摘要">
      <div><Clock3 :size="19" /><span>进行中<strong>{{ stats.active }}</strong></span></div>
      <div><CheckCircle2 :size="19" /><span>已完成<strong>{{ stats.ready }}</strong></span></div>
      <div :class="{ 'stat-danger': stats.failed > 0 }"><AlertTriangle :size="19" /><span>失败<strong>{{ stats.failed }}</strong></span></div>
      <div><DatabaseZap :size="19" /><span>总任务<strong>{{ jobs.length }}</strong></span></div>
    </div>

    <section class="surface">
      <div class="section-header">
        <div><h3>任务记录</h3><p>每 10 秒自动刷新</p></div>
        <div class="mini-tabs" aria-label="任务状态筛选"><button v-for="value in ['all', 'queued', 'processing', 'ready', 'failed'] as const" :key="value" type="button" :class="{ active: filter === value }" @click="filter = value">{{ { all: '全部', queued: '排队', processing: '处理中', ready: '完成', failed: '失败' }[value] }}</button></div>
      </div>
      <div v-if="loading" class="page-loading"><span class="spinner" />载入任务</div>
      <div v-else-if="filtered.length === 0" class="empty-state"><div><div class="empty-state-icon"><DatabaseZap :size="22" /></div><h3>没有任务记录</h3><p>创建或更新 Markdown 后，索引任务会显示在这里。</p></div></div>
      <div v-else class="data-table-wrap data-table-wrap--cards">
        <table class="data-table data-table--cards">
          <thead><tr><th>文档</th><th>类型</th><th>状态</th><th>尝试</th><th>更新时间</th><th>错误</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="job in filtered" :key="job.id">
              <td data-label="文档"><span class="mono">{{ job.noteId.slice(0, 12) }}</span><div class="table-meta">v{{ job.version ?? '-' }}</div></td>
              <td data-label="类型">{{ job.type === 'index' ? '索引' : '清理' }}</td>
              <td data-label="状态"><StatusBadge :status="job.status" /></td>
              <td class="mono" data-label="尝试">{{ job.attempts }}/5</td>
              <td data-label="更新时间">{{ formatDate(job.updatedAt) }}</td>
              <td data-label="错误"><span class="job-error" :title="job.lastError ?? ''">{{ job.lastError || '-' }}</span></td>
              <td data-label="操作"><div class="table-actions"><button class="icon-button icon-button--small" type="button" title="重试任务" aria-label="重试任务" :disabled="job.status !== 'failed'" @click="retry(job.id)"><RotateCcw :size="16" /></button></div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
