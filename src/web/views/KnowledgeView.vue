<script setup lang="ts">
import {
  BookOpenText,
  Clock3,
  Eye,
  FilePlus2,
  FolderPlus,
  History,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  Users,
} from "@lucide/vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CollectionSummary, NoteSummary, Role } from "@shared/contracts";
import { stripFrontmatter } from "@shared/markdown";
import ModalDialog from "@web/components/ModalDialog.vue";
import StatusBadge from "@web/components/StatusBadge.vue";
import { api, jsonBody } from "@web/lib/api";
import { useAppStore } from "@web/stores/app";
import { useToastStore } from "@web/stores/toast";

interface NoteDetail extends NoteSummary { markdown: string }
interface VersionRow { noteId: string; version: number; title: string; createdAt: string; createdBy: string }
interface MemberRow { collectionId: string; userEmail: string; role: Role; createdAt: string }

const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const toast = useToastStore();

const selectedCollectionId = ref("");
const notes = ref<NoteSummary[]>([]);
const selectedNote = ref<NoteDetail | null>(null);
const editorValue = ref("");
const loadingNotes = ref(false);
const loadingNote = ref(false);
const saving = ref(false);
const noteFilter = ref("");
const editorMode = ref<"write" | "split" | "preview">("split");

const showCollectionModal = ref(false);
const collectionForm = ref({ name: "", description: "" });
const creatingCollection = ref(false);
const showNoteModal = ref(false);
const noteForm = ref({ title: "", tags: "" });
const creatingNote = ref(false);
const showVersionsModal = ref(false);
const versions = ref<VersionRow[]>([]);
const showMembersModal = ref(false);
const members = ref<MemberRow[]>([]);
const memberForm = ref<{ email: string; role: Role }>({ email: "", role: "viewer" });

const selectedCollection = computed(() => appStore.collections.find((item) => item.id === selectedCollectionId.value) ?? null);
const canEdit = computed(() => selectedCollection.value?.role === "admin" || selectedCollection.value?.role === "editor");
const canAdmin = computed(() => selectedCollection.value?.role === "admin");
const dirty = computed(() => Boolean(selectedNote.value && editorValue.value !== selectedNote.value.markdown));
const previewHtml = computed(() => DOMPurify.sanitize(marked.parse(stripFrontmatter(editorValue.value), { async: false }) as string));
const filteredNotes = computed(() => {
  const query = noteFilter.value.trim().toLowerCase();
  if (!query) return notes.value;
  return notes.value.filter((note) => `${note.title} ${note.tags.join(" ")}`.toLowerCase().includes(query));
});

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function routeToCollection(collectionId: string) {
  if (dirty.value && !window.confirm("当前文档有未保存修改，确定离开吗？")) return;
  void router.push(`/knowledge/${collectionId}`);
}

async function loadNotes(collectionId: string, resetSelection = true) {
  loadingNotes.value = true;
  if (resetSelection) {
    selectedNote.value = null;
    editorValue.value = "";
  }
  try {
    notes.value = await api<NoteSummary[]>(`/api/v1/collections/${collectionId}/notes`);
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "文档列表加载失败", "error");
  } finally {
    loadingNotes.value = false;
  }
}

async function openNote(noteId: string, updateRoute = true) {
  if (dirty.value && selectedNote.value?.id !== noteId && !window.confirm("当前文档有未保存修改，确定离开吗？")) return;
  loadingNote.value = true;
  try {
    const detail = await api<NoteDetail>(`/api/v1/notes/${noteId}`);
    selectedNote.value = detail;
    editorValue.value = detail.markdown;
    if (updateRoute) await router.push(`/knowledge/${detail.collectionId}/notes/${detail.id}`);
    await nextTick();
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "文档加载失败", "error");
  } finally {
    loadingNote.value = false;
  }
}

async function saveNote() {
  if (!selectedNote.value || !dirty.value) return;
  saving.value = true;
  try {
    const result = await api<NoteSummary & { jobId: string | null }>(`/api/v1/notes/${selectedNote.value.id}`, {
      method: "PUT",
      headers: { "if-match": `"${selectedNote.value.version}"` },
      ...jsonBody({ markdown: editorValue.value }),
    });
    selectedNote.value = { ...selectedNote.value, ...result, markdown: editorValue.value };
    await Promise.all([loadNotes(selectedCollectionId.value, false), appStore.loadCollections()]);
    toast.show(result.jobId ? "已保存，索引任务已排队" : "内容没有变化", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    saving.value = false;
  }
}

async function createCollection() {
  creatingCollection.value = true;
  try {
    const created = await api<CollectionSummary>("/api/v1/collections", { method: "POST", ...jsonBody(collectionForm.value) });
    await appStore.loadCollections();
    showCollectionModal.value = false;
    collectionForm.value = { name: "", description: "" };
    await router.push(`/knowledge/${created.id}`);
    toast.show("知识库已创建", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "创建失败", "error");
  } finally {
    creatingCollection.value = false;
  }
}

async function createNewNote() {
  if (!selectedCollectionId.value) return;
  creatingNote.value = true;
  try {
    const tags = noteForm.value.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    const markdown = `---\ntitle: ${JSON.stringify(noteForm.value.title)}\ntags: ${JSON.stringify(tags)}\nstatus: published\n---\n\n# ${noteForm.value.title}\n\n`;
    const created = await api<NoteSummary>(`/api/v1/collections/${selectedCollectionId.value}/notes`, {
      method: "POST",
      ...jsonBody({ markdown }),
    });
    await Promise.all([loadNotes(selectedCollectionId.value), appStore.loadCollections()]);
    showNoteModal.value = false;
    noteForm.value = { title: "", tags: "" };
    await openNote(created.id);
    toast.show("文档已创建", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "创建失败", "error");
  } finally {
    creatingNote.value = false;
  }
}

async function deleteCurrentNote() {
  if (!selectedNote.value || !window.confirm(`确定删除“${selectedNote.value.title}”吗？历史版本将保留。`)) return;
  try {
    await api(`/api/v1/notes/${selectedNote.value.id}`, { method: "DELETE" });
    selectedNote.value = null;
    editorValue.value = "";
    await Promise.all([loadNotes(selectedCollectionId.value), appStore.loadCollections()]);
    await router.push(`/knowledge/${selectedCollectionId.value}`);
    toast.show("文档已移出检索索引", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "删除失败", "error");
  }
}

async function reindexCurrentNote() {
  if (!selectedNote.value) return;
  try {
    await api(`/api/v1/notes/${selectedNote.value.id}/reindex`, { method: "POST" });
    toast.show("重新索引任务已排队", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "任务提交失败", "error");
  }
}

async function openVersions() {
  if (!selectedNote.value) return;
  versions.value = await api<VersionRow[]>(`/api/v1/notes/${selectedNote.value.id}/versions`);
  showVersionsModal.value = true;
}

async function restoreVersion(version: number) {
  if (!selectedNote.value || !window.confirm(`将版本 ${version} 恢复为一个新版本吗？`)) return;
  try {
    await api(`/api/v1/notes/${selectedNote.value.id}/restore`, { method: "POST", ...jsonBody({ version }) });
    showVersionsModal.value = false;
    await loadNotes(selectedCollectionId.value, false);
    await openNote(selectedNote.value.id, false);
    toast.show("历史版本已恢复", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "恢复失败", "error");
  }
}

async function openMembers() {
  members.value = await api<MemberRow[]>(`/api/v1/collections/${selectedCollectionId.value}/members`);
  showMembersModal.value = true;
}

async function addMember() {
  try {
    await api(`/api/v1/collections/${selectedCollectionId.value}/members`, { method: "PUT", ...jsonBody(memberForm.value) });
    memberForm.value = { email: "", role: "viewer" };
    await openMembers();
    toast.show("成员权限已更新", "success");
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "成员更新失败", "error");
  }
}

async function removeMember(email: string) {
  if (!window.confirm(`移除成员 ${email} 吗？`)) return;
  try {
    await api(`/api/v1/collections/${selectedCollectionId.value}/members/${encodeURIComponent(email)}`, { method: "DELETE" });
    await openMembers();
  } catch (error) {
    toast.show(error instanceof Error ? error.message : "移除失败", "error");
  }
}

watch(
  () => [route.params.collectionId, route.params.noteId, appStore.collections.length] as const,
  async ([routeCollection, routeNote]) => {
    const fallback = appStore.collections[0]?.id ?? "";
    const nextId = typeof routeCollection === "string" && appStore.collections.some((item) => item.id === routeCollection) ? routeCollection : fallback;
    if (!nextId) return;
    if (selectedCollectionId.value !== nextId) {
      selectedCollectionId.value = nextId;
      await loadNotes(nextId);
    }
    const noteId = typeof routeNote === "string" ? routeNote : "";
    if (noteId && selectedNote.value?.id !== noteId) await openNote(noteId, false);
  },
  { immediate: true },
);

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => window.addEventListener("beforeunload", handleBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", handleBeforeUnload));
</script>

<template>
  <div class="page-stack knowledge-page">
    <div class="page-toolbar">
      <div>
        <h2>知识工作区</h2>
        <p>管理经过审核的 Markdown，并保持 Agent 检索来源可追溯。</p>
      </div>
      <div class="toolbar-actions">
        <button v-if="canAdmin" class="button button--secondary" type="button" @click="openMembers">
          <Users :size="17" /> 成员
        </button>
        <button class="button button--secondary" type="button" @click="showCollectionModal = true">
          <FolderPlus :size="17" /> 新建知识库
        </button>
        <button class="button button--primary" type="button" :disabled="!canEdit" @click="showNoteModal = true">
          <FilePlus2 :size="17" /> 新建文档
        </button>
      </div>
    </div>

    <section v-if="appStore.collections.length === 0" class="surface empty-state">
      <div>
        <div class="empty-state-icon"><BookOpenText :size="22" /></div>
        <h3>还没有知识库</h3>
        <p>创建第一个知识库后即可维护 Markdown、分配权限并连接 Agent。</p>
        <button class="button button--primary" type="button" @click="showCollectionModal = true"><Plus :size="17" />创建知识库</button>
      </div>
    </section>

    <section v-else class="knowledge-layout surface">
      <aside class="collection-pane" aria-label="知识库列表">
        <div class="pane-heading"><span>知识库</span><span>{{ appStore.collections.length }}</span></div>
        <button
          v-for="collection in appStore.collections"
          :key="collection.id"
          class="collection-item"
          :class="{ 'collection-item--active': collection.id === selectedCollectionId }"
          type="button"
          @click="routeToCollection(collection.id)"
        >
          <span class="collection-icon"><BookOpenText :size="16" /></span>
          <span><strong>{{ collection.name }}</strong><small>{{ collection.noteCount }} 篇文档 · {{ collection.role }}</small></span>
        </button>
      </aside>

      <aside class="note-pane" aria-label="文档列表">
        <div class="pane-heading"><span>{{ selectedCollection?.name }}</span><span>{{ notes.length }}</span></div>
        <label class="list-search">
          <Search :size="16" aria-hidden="true" />
          <span class="sr-only">筛选文档</span>
          <input v-model="noteFilter" type="search" placeholder="筛选标题或标签" />
        </label>
        <div v-if="loadingNotes" class="inline-loading"><LoaderCircle :size="17" class="spin-icon" />载入文档</div>
        <div v-else-if="filteredNotes.length === 0" class="pane-empty">该知识库还没有可见文档</div>
        <button
          v-for="note in filteredNotes"
          v-else
          :key="note.id"
          class="note-item"
          :class="{ 'note-item--active': note.id === selectedNote?.id }"
          type="button"
          @click="openNote(note.id)"
        >
          <span class="note-item-top"><strong>{{ note.title }}</strong><StatusBadge :status="note.indexedVersion === note.version ? 'ready' : 'queued'" /></span>
          <span class="note-tags">{{ note.tags.length ? note.tags.join(' · ') : '无标签' }}</span>
          <span class="note-date"><Clock3 :size="12" />{{ formatDate(note.updatedAt) }}</span>
        </button>
      </aside>

      <div class="editor-pane">
        <div v-if="loadingNote" class="page-loading"><span class="spinner" />载入 Markdown</div>
        <div v-else-if="!selectedNote" class="empty-state">
          <div>
            <div class="empty-state-icon"><PencilLine :size="22" /></div>
            <h3>选择一篇文档</h3>
            <p>在左侧选择文档以编辑 Markdown、查看预览或恢复历史版本。</p>
          </div>
        </div>
        <template v-else>
          <header class="editor-header">
            <div class="editor-title">
              <div><h3>{{ selectedNote.title }}</h3><span>v{{ selectedNote.version }} · {{ dirty ? '有未保存修改' : '已保存' }}</span></div>
            </div>
            <div class="editor-actions">
              <div class="segmented" aria-label="编辑器视图">
                <button type="button" :class="{ active: editorMode === 'write' }" @click="editorMode = 'write'"><PencilLine :size="15" /><span>编辑</span></button>
                <button type="button" :class="{ active: editorMode === 'split' }" @click="editorMode = 'split'"><Settings2 :size="15" /><span>分栏</span></button>
                <button type="button" :class="{ active: editorMode === 'preview' }" @click="editorMode = 'preview'"><Eye :size="15" /><span>预览</span></button>
              </div>
              <button class="icon-button" type="button" title="版本记录" aria-label="版本记录" @click="openVersions"><History :size="18" /></button>
              <button class="icon-button" type="button" title="重新索引" aria-label="重新索引" @click="reindexCurrentNote"><RefreshCw :size="18" /></button>
              <button class="icon-button danger-icon" type="button" title="删除文档" aria-label="删除文档" @click="deleteCurrentNote"><Trash2 :size="18" /></button>
              <button class="button button--primary" type="button" :disabled="!dirty || saving || !canEdit" @click="saveNote">
                <span v-if="saving" class="spinner" /><Save v-else :size="17" />保存
              </button>
            </div>
          </header>
          <div class="editor-workspace" :class="`editor-workspace--${editorMode}`">
            <label v-if="editorMode !== 'preview'" class="markdown-editor">
              <span class="sr-only">Markdown 内容</span>
              <textarea v-model="editorValue" spellcheck="false" :readonly="!canEdit" />
            </label>
            <article v-if="editorMode !== 'write'" class="markdown-preview" v-html="previewHtml" />
          </div>
        </template>
      </div>
    </section>
  </div>

  <ModalDialog v-if="showCollectionModal" title="新建知识库" description="知识库是权限和 Agent 检索范围的边界。" @close="showCollectionModal = false">
    <form id="collection-form" class="form-grid" @submit.prevent="createCollection">
      <div class="field"><label for="collection-name">名称</label><input id="collection-name" v-model="collectionForm.name" class="input" required maxlength="80" autofocus /></div>
      <div class="field"><label for="collection-description">描述</label><textarea id="collection-description" v-model="collectionForm.description" class="textarea" maxlength="500" /></div>
    </form>
    <template #footer><button class="button button--secondary" type="button" @click="showCollectionModal = false">取消</button><button class="button button--primary" type="submit" form="collection-form" :disabled="creatingCollection"><span v-if="creatingCollection" class="spinner" />创建</button></template>
  </ModalDialog>

  <ModalDialog v-if="showNoteModal" title="新建 Markdown" description="系统会自动补充稳定 ID 和版本号。" @close="showNoteModal = false">
    <form id="note-form" class="form-grid" @submit.prevent="createNewNote">
      <div class="field"><label for="note-title">标题</label><input id="note-title" v-model="noteForm.title" class="input" required maxlength="160" autofocus /></div>
      <div class="field"><label for="note-tags">标签</label><input id="note-tags" v-model="noteForm.tags" class="input" placeholder="架构, MCP, Cloudflare" /><p class="field-hint">使用英文逗号分隔标签。</p></div>
    </form>
    <template #footer><button class="button button--secondary" type="button" @click="showNoteModal = false">取消</button><button class="button button--primary" type="submit" form="note-form" :disabled="creatingNote"><span v-if="creatingNote" class="spinner" />创建并编辑</button></template>
  </ModalDialog>

  <ModalDialog v-if="showVersionsModal" title="版本记录" :description="selectedNote?.title" @close="showVersionsModal = false">
    <div class="version-list">
      <div v-for="version in versions" :key="version.version" class="version-row">
        <div><strong>版本 {{ version.version }}</strong><span>{{ formatDate(version.createdAt) }} · {{ version.createdBy }}</span></div>
        <button class="button button--secondary" type="button" :disabled="version.version === selectedNote?.version" @click="restoreVersion(version.version)">恢复</button>
      </div>
    </div>
  </ModalDialog>

  <ModalDialog v-if="showMembersModal" title="知识库成员" :description="selectedCollection?.name" wide @close="showMembersModal = false">
    <form class="member-form" @submit.prevent="addMember">
      <div class="field"><label for="member-email">邮箱</label><input id="member-email" v-model="memberForm.email" class="input" type="email" required /></div>
      <div class="field"><label for="member-role">角色</label><select id="member-role" v-model="memberForm.role" class="select"><option value="viewer">只读</option><option value="editor">编辑者</option><option value="admin">管理员</option></select></div>
      <button class="button button--primary" type="submit">添加或更新</button>
    </form>
    <div class="data-table-wrap member-table"><table class="data-table"><thead><tr><th>成员</th><th>角色</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="member in members" :key="member.userEmail"><td>{{ member.userEmail }}</td><td>{{ member.role }}</td><td><div class="table-actions"><button class="icon-button icon-button--small" type="button" aria-label="移除成员" @click="removeMember(member.userEmail)"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div>
  </ModalDialog>
</template>
