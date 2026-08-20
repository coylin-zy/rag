<script setup lang="ts">
import { ArrowLeft, GitCompareArrows, History, LoaderCircle, RotateCcw } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import type { NoteSummary } from "@shared/contracts";
import { api, jsonBody } from "@web/lib/api";
import { buildVersionDiff, type VersionDiffResult } from "@web/lib/versionDiff";
import { useAppStore } from "@web/stores/app";
import { useToastStore } from "@web/stores/toast";
import "@web/version-history.css";

interface NoteDetail extends NoteSummary { markdown: string }
interface VersionRow { noteId: string; version: number; title: string; createdAt: string; createdBy: string }
interface VersionDetail extends VersionRow { collectionId: string; currentVersion: number; markdown: string }

const route = useRoute();
const appStore = useAppStore();
const toast = useToastStore();
const note = ref<NoteDetail | null>(null);
const versions = ref<VersionRow[]>([]);
const leftVersion = ref<number | null>(null);
const rightVersion = ref<number | null>(null);
const leftDetail = ref<VersionDetail | null>(null);
const rightDetail = ref<VersionDetail | null>(null);
const loading = ref(false);
const comparing = ref(false);
const restoring = ref(false);

const noteId = computed(() => typeof route.params.noteId === "string" ? route.params.noteId : "");
const selectedCollection = computed(() => appStore.collections.find((item) => item.id === note.value?.collectionId) ?? null);
const canEdit = computed(() => selectedCollection.value?.role === "editor" || selectedCollection.value?.role === "admin");
const diff = computed<VersionDiffResult | null>(() => leftDetail.value && rightDetail.value ? buildVersionDiff(leftDetail.value.markdown, rightDetail.value.markdown) : null);
const metadataKeys = computed(() => diff.value ? [...new Set([...Object.keys(diff.value.metadataBefore), ...Object.keys(diff.value.metadataAfter)])].sort() : []);

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatMetadata(value: unknown) {
  if (value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  return JSON.stringify(value, null, 2);
}

async function loadVersion(version: number): Promise<VersionDetail> {
  if (note.value && version === note.value.version) {
    const row = versions.value.find((item) => item.version === version);
    return {
      noteId: note.value.id,
      version,
      title: row?.title ?? note.value.title,
      createdAt: row?.createdAt ?? note.value.updatedAt,
      createdBy: row?.createdBy ?? note.value.updatedBy,
      collectionId: note.value.collectionId,
      currentVersion: note.value.version,
      markdown: note.value.markdown,
    };
  }
  return api<VersionDetail>(`/api/v1/notes/${noteId.value}/versions/${version}`);
}

async function compareSelected() {
  if (!leftVersion.value || !rightVersion.value) return;
  comparing.value = true;
  try {
    [leftDetail.value, rightDetail.value] = await Promise.all([loadVersion(leftVersion.value), loadVersion(rightVersion.value)]);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "版本读取失败", "error");
  } finally {
    comparing.value = false;
  }
}

async function loadWorkspace() {
  if (!noteId.value) return;
  loading.value = true;
  try {
    [note.value, versions.value] = await Promise.all([
      api<NoteDetail>(`/api/v1/notes/${noteId.value}`),
      api<VersionRow[]>(`/api/v1/notes/${noteId.value}/versions`),
    ]);
    rightVersion.value = note.value.version;
    leftVersion.value = versions.value.find((item) => item.version < note.value!.version)?.version ?? note.value.version;
    await compareSelected();
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "版本工作区加载失败", "error");
  } finally {
    loading.value = false;
  }
}

async function restoreLeftVersion() {
  if (!note.value || !leftVersion.value || leftVersion.value === note.value.version || !canEdit.value) return;
  if (!window.confirm(`将版本 ${leftVersion.value} 恢复为新的 v${note.value.version + 1} 吗？历史版本不会被覆盖。`)) return;
  restoring.value = true;
  try {
    const result = await api<{ version: number }>(`/api/v1/notes/${note.value.id}/restore`, {
      method: "POST",
      headers: { "if-match": `"${note.value.version}"` },
      ...jsonBody({ version: leftVersion.value }),
    });
    toast.show(`已从 v${leftVersion.value} 创建 v${result.version}，索引任务已排队`, "success");
    await loadWorkspace();
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "版本回滚失败，请刷新 Diff 后重试", "error");
  } finally {
    restoring.value = false;
  }
}

watch([leftVersion, rightVersion], () => {
  if (!loading.value && leftVersion.value && rightVersion.value) void compareSelected();
});
onMounted(loadWorkspace);
</script>

<template>
  <section class="version-page">
    <header class="version-header">
      <div>
        <RouterLink v-if="note" class="version-back" :to="`/knowledge/${note.collectionId}/notes/${note.id}`"><ArrowLeft :size="16" />返回文档</RouterLink>
        <p>VERSION HISTORY</p><h2>{{ note?.title || '版本差异' }}</h2>
        <span v-if="note">当前 v{{ note.version }} · 回滚只会创建新版本，不会覆盖历史</span>
      </div>
      <button class="button button--primary" type="button" :disabled="!canEdit || restoring || !note || leftVersion === note.version" @click="restoreLeftVersion"><span v-if="restoring" class="spinner" /><RotateCcw v-else :size="17" />恢复左侧版本</button>
    </header>

    <div v-if="loading" class="page-loading"><LoaderCircle :size="20" class="spin-icon" />载入版本历史</div>
    <template v-else-if="note">
      <div class="version-controls">
        <label><span>旧版本</span><select v-model.number="leftVersion" class="select"><option v-for="item in versions" :key="`left-${item.version}`" :value="item.version">v{{ item.version }} · {{ formatDate(item.createdAt) }}</option></select></label>
        <GitCompareArrows :size="21" aria-hidden="true" />
        <label><span>新版本</span><select v-model.number="rightVersion" class="select"><option v-for="item in versions" :key="`right-${item.version}`" :value="item.version">v{{ item.version }} · {{ formatDate(item.createdAt) }}</option></select></label>
      </div>

      <div v-if="comparing" class="diff-loading"><span class="spinner" />正在比较</div>
      <template v-else-if="diff && leftDetail && rightDetail">
        <div v-if="diff.identityMismatch" class="diff-warning" role="alert">两个版本的文档 ID 不一致，已阻止把它们视为同一条知识。</div>
        <section class="metadata-diff">
          <header><History :size="17" /><strong>Frontmatter</strong><span>自动生成的 version 字段已忽略</span></header>
          <div class="metadata-grid metadata-grid--head"><span>字段</span><span>v{{ leftDetail.version }}</span><span>v{{ rightDetail.version }}</span></div>
          <div v-for="key in metadataKeys" :key="key" class="metadata-grid"><strong>{{ key }}</strong><pre>{{ formatMetadata(diff.metadataBefore[key]) }}</pre><pre>{{ formatMetadata(diff.metadataAfter[key]) }}</pre></div>
          <div v-if="metadataKeys.length === 0" class="diff-empty">两个版本都没有可比较的 frontmatter 字段。</div>
        </section>

        <section class="body-diff">
          <header><GitCompareArrows :size="17" /><strong>正文行级 Diff</strong><span v-if="diff.truncated">差异过大，已折叠中段</span></header>
          <div class="diff-columns diff-columns--head"><span>v{{ leftDetail.version }}</span><span>v{{ rightDetail.version }}</span></div>
          <div v-if="diff.rows.length === 0" class="diff-empty">正文没有差异。</div>
          <div v-for="(row, index) in diff.rows" v-else :key="index" class="diff-row" :class="`diff-row--${row.kind}`">
            <div class="diff-cell diff-cell--old"><span class="diff-line-number">{{ row.oldLine ?? '' }}</span><code>{{ row.oldText || (row.kind === 'truncated' ? row.newText : '') }}</code></div>
            <div class="diff-cell diff-cell--new"><span class="diff-line-number">{{ row.newLine ?? '' }}</span><code>{{ row.newText }}</code></div>
          </div>
        </section>
      </template>
    </template>
  </section>
</template>
