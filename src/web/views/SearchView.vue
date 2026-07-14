<script setup lang="ts">
import { BookOpen, Filter, Search, SlidersHorizontal } from "@lucide/vue";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import type { SearchResult } from "@shared/contracts";
import { api, jsonBody } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import { useToastStore } from "@web/stores/toast";

const appStore = useAppStore();
const toast = useToastStore();
const MAX_SEARCH_COLLECTIONS = 10;
const query = ref("");
const selectedCollections = ref(appStore.collections.slice(0, MAX_SEARCH_COLLECTIONS).map((item) => item.id));
const tags = ref("");
const limit = ref(8);
const results = ref<SearchResult[]>([]);
const searching = ref(false);
const hasSearched = ref(false);

const bulkSelection = computed(() => appStore.collections.slice(0, MAX_SEARCH_COLLECTIONS).map((item) => item.id));
const allSelected = computed(() => (
  bulkSelection.value.length > 0
  && selectedCollections.value.length === bulkSelection.value.length
  && bulkSelection.value.every((id) => selectedCollections.value.includes(id))
));
const selectionAtLimit = computed(() => selectedCollections.value.length >= MAX_SEARCH_COLLECTIONS);

function toggleAll() {
  selectedCollections.value = allSelected.value ? [] : [...bulkSelection.value];
}

function toggleCollection(collectionId: string) {
  if (selectedCollections.value.includes(collectionId)) {
    selectedCollections.value = selectedCollections.value.filter((id) => id !== collectionId);
    return;
  }
  if (selectionAtLimit.value) {
    toast.show(`单次最多选择 ${MAX_SEARCH_COLLECTIONS} 个知识库`, "error");
    return;
  }
  selectedCollections.value = [...selectedCollections.value, collectionId];
}

function formatScore(score: number) {
  return score >= 1 ? score.toFixed(3) : score.toFixed(5);
}

async function runSearch() {
  if (!query.value.trim()) return;
  const collectionIds = selectedCollections.value;
  if (!collectionIds.length) {
    toast.show("请至少选择一个知识库", "error");
    return;
  }
  searching.value = true;
  try {
    results.value = await api<SearchResult[]>("/api/v1/search", {
      method: "POST",
      ...jsonBody({
        query: query.value,
        collectionIds,
        tags: tags.value.split(",").map((item) => item.trim()).filter(Boolean),
        limit: limit.value,
      }),
    });
    hasSearched.value = true;
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "检索失败", "error");
  } finally {
    searching.value = false;
  }
}
</script>

<template>
  <div class="page-stack search-page">
    <div class="page-toolbar">
      <div><span class="page-eyebrow">RETRIEVAL LAB</span><h2>混合检索调试</h2><p>用真实问题验证关键词、语义召回、RRF 融合与重排后的来源。</p></div>
    </div>

    <form class="search-console surface" @submit.prevent="runSearch">
      <div class="search-query-row">
        <Search :size="20" aria-hidden="true" />
        <label class="sr-only" for="search-query">检索问题</label>
        <input id="search-query" v-model="query" type="search" placeholder="输入 Agent 可能提出的问题、术语或编号" required autofocus />
        <button class="button button--primary" type="submit" :disabled="searching">
          <span v-if="searching" class="spinner" /><Search v-else :size="17" />检索
        </button>
      </div>
      <div class="search-filters">
        <div class="filter-group">
          <span class="field-label"><BookOpen :size="15" />知识库</span>
          <button class="filter-chip" :class="{ active: allSelected }" type="button" @click="toggleAll">{{ appStore.collections.length > MAX_SEARCH_COLLECTIONS ? '最近 10 个' : '全部' }}</button>
          <label v-for="collection in appStore.collections" :key="collection.id" class="filter-chip" :class="{ active: selectedCollections.includes(collection.id) }">
            <input
              type="checkbox"
              :checked="selectedCollections.includes(collection.id)"
              :disabled="selectionAtLimit && !selectedCollections.includes(collection.id)"
              @change="toggleCollection(collection.id)"
            />{{ collection.name }}
          </label>
        </div>
        <div class="filter-controls">
          <label class="compact-field"><Filter :size="15" /><span>标签</span><input v-model="tags" placeholder="MCP, 架构" /></label>
          <label class="compact-field"><SlidersHorizontal :size="15" /><span>条数</span><select v-model="limit"><option :value="5">5</option><option :value="8">8</option></select></label>
        </div>
      </div>
    </form>

    <section class="surface search-results">
      <div class="section-header">
        <div><h3>检索结果</h3><p>{{ hasSearched ? `返回 ${results.length} 条可引用片段` : '尚未执行检索' }}</p></div>
      </div>
      <div v-if="!hasSearched" class="empty-state"><div><div class="empty-state-icon"><Search :size="22" /></div><h3>用真实问题验证召回</h3><p>结果会展示来源 URI、标题路径和最终排序分数，不生成答案。</p></div></div>
      <div v-else-if="results.length === 0" class="empty-state"><div><div class="empty-state-icon"><Search :size="22" /></div><h3>没有匹配结果</h3><p>检查索引任务是否完成，或放宽知识库和标签筛选条件。</p></div></div>
      <ol v-else class="result-list">
        <li v-for="(result, index) in results" :key="result.chunkId" class="result-item">
          <div class="result-rank">{{ index + 1 }}</div>
          <div class="result-content">
            <div class="result-heading">
              <div><RouterLink :to="`/knowledge/${result.collectionId}/notes/${result.noteId}`">{{ result.title }}</RouterLink><span v-if="result.headingPath.length">{{ result.headingPath.join(' / ') }}</span></div>
              <span class="score-pill">{{ formatScore(result.score) }}</span>
            </div>
            <p>{{ result.excerpt }}</p>
            <div class="result-uri"><BookOpen :size="13" />{{ result.resourceUri }} · v{{ result.version }}</div>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
