<script setup lang="ts">
import { Check, Inbox, MessageSquareText, RefreshCw, X } from "@lucide/vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed, onMounted, ref } from "vue";

import { stripFrontmatter } from "@shared/markdown";
import ModalDialog from "@web/components/ModalDialog.vue";
import StatusBadge from "@web/components/StatusBadge.vue";
import { api, jsonBody } from "@web/lib/api";
import { useToastStore } from "@web/stores/toast";

interface Proposal {
  id: string;
  collectionId: string;
  title: string;
  tags: string[];
  source: string;
  status: "pending" | "approved" | "rejected";
  submittedByTokenId: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  approvedNoteId: string | null;
}
interface ProposalDetail extends Proposal { markdown: string }

const toast = useToastStore();
const proposals = ref<Proposal[]>([]);
const selected = ref<ProposalDetail | null>(null);
const filter = ref<"all" | Proposal["status"]>("pending");
const loading = ref(false);
const showReview = ref(false);
const decision = ref<"approved" | "rejected">("approved");
const reviewNote = ref("");
const reviewing = ref(false);

const filtered = computed(() => filter.value === "all" ? proposals.value : proposals.value.filter((item) => item.status === filter.value));
const previewHtml = computed(() => selected.value ? DOMPurify.sanitize(marked.parse(stripFrontmatter(selected.value.markdown), { async: false }) as string) : "");

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

async function loadProposals() {
  loading.value = true;
  try {
    proposals.value = await api<Proposal[]>("/api/v1/proposals");
    if (selected.value) {
      const fresh = proposals.value.find((item) => item.id === selected.value?.id);
      if (fresh) selected.value = { ...selected.value, ...fresh };
    }
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "提案加载失败", "error");
  } finally {
    loading.value = false;
  }
}

async function openProposal(id: string) {
  try {
    selected.value = await api<ProposalDetail>(`/api/v1/proposals/${id}`);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "提案内容加载失败", "error");
  }
}

function startReview(nextDecision: "approved" | "rejected") {
  decision.value = nextDecision;
  reviewNote.value = "";
  showReview.value = true;
}

async function submitReview() {
  if (!selected.value) return;
  reviewing.value = true;
  try {
    await api(`/api/v1/proposals/${selected.value.id}/review`, {
      method: "POST",
      ...jsonBody({ decision: decision.value, reviewNote: reviewNote.value }),
    });
    showReview.value = false;
    await Promise.all([loadProposals(), openProposal(selected.value.id)]);
    toast.show(decision.value === "approved" ? "提案已晋升为正式知识" : "提案已拒绝", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "审核失败", "error");
  } finally {
    reviewing.value = false;
  }
}

onMounted(loadProposals);
</script>

<template>
  <div class="page-stack proposals-page">
    <div class="page-toolbar">
      <div><span class="page-eyebrow">MEMORY REVIEW</span><h2>Agent 记忆审核</h2><p>检查来源与 Markdown 变更；只有人工批准的提案才会进入正式知识。</p></div>
      <div class="toolbar-actions"><button class="button button--secondary" type="button" :disabled="loading" @click="loadProposals"><RefreshCw :size="17" />刷新</button></div>
    </div>

    <section class="proposal-layout surface">
      <aside class="proposal-list-pane">
        <div class="proposal-filters" aria-label="提案筛选">
          <button v-for="value in ['pending', 'approved', 'rejected', 'all'] as const" :key="value" type="button" :class="{ active: filter === value }" @click="filter = value">
            {{ { pending: '待审核', approved: '已通过', rejected: '已拒绝', all: '全部' }[value] }}
          </button>
        </div>
        <div v-if="loading" class="inline-loading"><span class="spinner" />载入提案</div>
        <div v-else-if="filtered.length === 0" class="pane-empty">当前筛选下没有提案</div>
        <button v-for="proposal in filtered" v-else :key="proposal.id" class="proposal-list-item" :class="{ active: selected?.id === proposal.id }" type="button" @click="openProposal(proposal.id)">
          <span class="proposal-list-top"><strong>{{ proposal.title }}</strong><StatusBadge :status="proposal.status" /></span>
          <span>{{ proposal.source || 'agent' }}</span>
          <small>{{ formatDate(proposal.createdAt) }}</small>
        </button>
      </aside>

      <div class="proposal-detail">
        <div v-if="!selected" class="empty-state"><div><div class="empty-state-icon"><Inbox :size="22" /></div><h3>选择一条记忆提案</h3><p>审核来源、Markdown 内容和标签，再决定是否晋升为正式知识。</p></div></div>
        <template v-else>
          <header class="proposal-detail-header">
            <div><div class="proposal-title-line"><h3>{{ selected.title }}</h3><StatusBadge :status="selected.status" /></div><p>{{ selected.source }} · {{ formatDate(selected.createdAt) }}</p></div>
            <div v-if="selected.status === 'pending'" class="toolbar-actions">
              <button class="button button--danger" type="button" @click="startReview('rejected')"><X :size="17" />拒绝</button>
              <button class="button button--primary" type="button" @click="startReview('approved')"><Check :size="17" />批准并发布</button>
            </div>
          </header>
          <div class="proposal-meta-strip"><span v-for="tag in selected.tags" :key="tag">{{ tag }}</span><span v-if="selected.tags.length === 0">无标签</span></div>
          <article class="markdown-preview proposal-markdown" v-html="previewHtml" />
          <div v-if="selected.reviewedAt" class="review-record"><MessageSquareText :size="17" /><div><strong>{{ selected.reviewedBy }}</strong><p>{{ selected.reviewNote || '未填写审核备注' }}</p></div></div>
        </template>
      </div>
    </section>
  </div>

  <ModalDialog v-if="showReview" :title="decision === 'approved' ? '批准记忆提案' : '拒绝记忆提案'" :description="selected?.title" @close="showReview = false">
    <form id="review-form" class="form-grid" @submit.prevent="submitReview">
      <div class="review-callout" :class="`review-callout--${decision}`">
        <Check v-if="decision === 'approved'" :size="19" /><X v-else :size="19" />
        <span>{{ decision === 'approved' ? '批准后将创建正式 Markdown，并立即触发索引任务。' : '拒绝后提案会保留在审计记录中，但不会进入检索。' }}</span>
      </div>
      <div class="field"><label for="review-note">审核备注</label><textarea id="review-note" v-model="reviewNote" class="textarea" maxlength="1000" /></div>
    </form>
    <template #footer><button class="button button--secondary" type="button" @click="showReview = false">取消</button><button class="button" :class="decision === 'approved' ? 'button--primary' : 'button--danger'" type="submit" form="review-form" :disabled="reviewing"><span v-if="reviewing" class="spinner" />确认</button></template>
  </ModalDialog>
</template>
