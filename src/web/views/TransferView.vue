<script setup lang="ts">
import { computed, ref } from "vue";

import { api, ApiClientError, jsonBody } from "@web/lib/api";
import { createStoredZip, parseZip } from "@web/lib/zip";
import { useAppStore } from "@web/stores/app";

interface PreparedFile {
  path: string;
  markdown: string;
  bytes: number;
}

interface ImportItem {
  id: string;
  relativePath: string;
  action: "create" | "update" | "unchanged" | "conflict" | "conflict_deleted" | "invalid" | null;
  decision: "skip" | "overwrite" | "copy" | null;
  decisionPath: string | null;
  status: string;
  attempts: number;
  targetNoteId: string | null;
  expectedVersion: number | null;
  resultNoteId: string | null;
  resultVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface ImportJob {
  id: string;
  collectionId: string;
  status: string;
  planVersion: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  conflictItems: number;
  invalidItems: number;
  totalBytes: number;
  items: ImportItem[];
}

interface ExportObject {
  id: string;
  logicalPath: string;
  objectKind: string;
  sha256: string;
  byteSize: number;
}

interface ExportManifest {
  formatVersion: number;
  kind: "portable" | "full_backup";
  createdAt: string;
  collection: { id: string; name: string };
  notes: Array<{ id: string; path: string }>;
  includesHistory: boolean;
  includesTrash: boolean;
  objects: ExportObject[];
}

const appStore = useAppStore();
const selectedCollectionId = ref(appStore.collections[0]?.id ?? "");
const prepared = ref<PreparedFile[]>([]);
const importJob = ref<ImportJob | null>(null);
const conflictDecisions = ref<Record<string, { decision: "skip" | "overwrite" | "copy"; copyPath: string }>>({});
const busy = ref(false);
const message = ref("");
const errorMessage = ref("");
const uploadProgress = ref({ done: 0, total: 0 });
const exportProgress = ref({ done: 0, total: 0 });
const lastBackup = ref<{ jobId: string; manifestHash: string } | null>(null);

const selectedCollection = computed(() => appStore.collections.find((item) => item.id === selectedCollectionId.value) ?? null);
const canEdit = computed(() => selectedCollection.value?.role === "admin" || selectedCollection.value?.role === "editor");
const bootstrapAdmin = computed(() => appStore.session?.principal.bootstrapAdmin ?? false);
const planCounts = computed(() => {
  const counts: Record<string, number> = { create: 0, update: 0, unchanged: 0, conflict: 0, conflict_deleted: 0, invalid: 0 };
  for (const item of importJob.value?.items ?? []) if (item.action) counts[item.action] = (counts[item.action] ?? 0) + 1;
  return counts;
});

function clearStatus() {
  message.value = "";
  errorMessage.value = "";
}

function showError(error: unknown) {
  errorMessage.value = error instanceof ApiClientError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : "操作失败";
}

function commonFolderPrefix(paths: string[]) {
  if (!paths.length) return "";
  const firstSegments = paths.map((value) => value.replace(/\\/g, "/").split("/")[0]);
  return firstSegments.every((segment) => segment && segment === firstSegments[0]) ? `${firstSegments[0]}/` : "";
}

async function decodeFiles(files: Array<{ path: string; blob: Blob }>) {
  if (files.length > 500) throw new Error("单个任务最多 500 篇 Markdown");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  const output: PreparedFile[] = [];
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, "/");
    if (!normalizedPath.toLowerCase().endsWith(".md")) throw new Error(`只接受 .md：${normalizedPath}`);
    if (file.blob.size > 2 * 1024 * 1024) throw new Error(`单篇超过 2 MiB：${normalizedPath}`);
    total += file.blob.size;
    if (total > 100 * 1024 * 1024) throw new Error("Markdown 总量超过 100 MiB");
    const markdown = decoder.decode(await file.blob.arrayBuffer());
    output.push({ path: normalizedPath, markdown, bytes: file.blob.size });
  }
  prepared.value = output;
  importJob.value = null;
  conflictDecisions.value = {};
  message.value = `已准备 ${output.length} 篇 Markdown，共 ${(total / 1024 / 1024).toFixed(2)} MiB`;
}

async function selectFolder(event: Event) {
  clearStatus();
  try {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    const paths = files.map((file) => file.webkitRelativePath || file.name);
    const prefix = commonFolderPrefix(paths);
    await decodeFiles(files.map((file, index) => ({
      path: paths[index].replace(prefix, ""),
      blob: file,
    })));
  } catch (error) {
    showError(error);
  }
}

async function selectZip(event: Event) {
  clearStatus();
  try {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const entries = await parseZip(file);
    const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
    if (manifestEntry) {
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.bytes)) as ExportManifest;
      if (manifest.kind !== "portable") throw new Error("完整灾备不能通过标准 Markdown 导入器恢复；请使用 verify-backup / 恢复流程");
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      const root = manifest.objects.find((entry) => entry.objectKind === "current_markdown")?.logicalPath.split("/notes/")[0];
      if (!root) throw new Error("portable manifest 缺少当前 Markdown 对象");
      const files: Array<{ path: string; blob: Blob }> = [];
      for (const note of manifest.notes) {
        const logicalPath = `${root}/notes/${note.path}`;
        const entry = byPath.get(logicalPath);
        if (!entry) throw new Error(`portable ZIP 缺少 ${logicalPath}`);
        files.push({ path: note.path, blob: new Blob([entry.bytes], { type: "text/markdown" }) });
      }
      await decodeFiles(files);
      return;
    }
    if (entries.some((entry) => entry.path.startsWith("history/") || entry.path.startsWith("recovery/"))) {
      throw new Error("标准 Markdown ZIP 不能包含 history/ 或 recovery/ 保留路径");
    }
    await decodeFiles(entries.map((entry) => ({ path: entry.path, blob: new Blob([entry.bytes]) })));
  } catch (error) {
    showError(error);
  }
}

async function startImport() {
  if (!selectedCollectionId.value || !prepared.value.length || !canEdit.value) return;
  clearStatus();
  busy.value = true;
  uploadProgress.value = { done: 0, total: prepared.value.length };
  try {
    const created = await api<{ id: string }>(`/api/v1/collections/${selectedCollectionId.value}/import-jobs`, { method: "POST" });
    for (const file of prepared.value) {
      const itemId = crypto.randomUUID();
      await api(`/api/v1/import-jobs/${created.id}/items/${itemId}`, {
        method: "PUT",
        ...jsonBody({ relativePath: file.path, markdown: file.markdown }),
      });
      uploadProgress.value.done += 1;
    }
    importJob.value = await api<ImportJob>(`/api/v1/import-jobs/${created.id}/plan`, { method: "POST" });
    for (const item of importJob.value.items) {
      if (item.action === "conflict" || item.action === "conflict_deleted") {
        conflictDecisions.value[item.id] = { decision: "skip", copyPath: "" };
      }
    }
    message.value = "dry-run 已完成；冲突默认跳过，请确认后执行。";
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function refreshImport() {
  if (!importJob.value) return;
  try {
    importJob.value = await api<ImportJob>(`/api/v1/import-jobs/${importJob.value.id}`);
  } catch (error) {
    showError(error);
  }
}

async function applyImport() {
  if (!importJob.value || importJob.value.status !== "planned") return;
  clearStatus();
  busy.value = true;
  try {
    const decisions = Object.entries(conflictDecisions.value).map(([itemId, value]) => ({
      itemId,
      decision: value.decision,
      copyPath: value.decision === "copy" ? value.copyPath : null,
    }));
    importJob.value = await api<ImportJob>(`/api/v1/import-jobs/${importJob.value.id}/apply`, {
      method: "POST",
      ...jsonBody({ planVersion: importJob.value.planVersion, decisions }),
    });
    for (let attempt = 0; attempt < 30 && ["queued", "processing"].includes(importJob.value.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refreshImport();
    }
    message.value = importJob.value.failedItems
      ? `任务已收敛：${importJob.value.completedItems} 完成，${importJob.value.failedItems} 失败。`
      : `导入完成：${importJob.value.completedItems} 项。`;
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function cancelImport() {
  if (!importJob.value) return;
  clearStatus();
  try {
    importJob.value = await api<ImportJob>(`/api/v1/import-jobs/${importJob.value.id}/cancel`, { method: "POST" });
    message.value = "未开始的导入项已取消；已经落库的版本不会回滚。";
  } catch (error) {
    showError(error);
  }
}

async function digestHex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportZip(kind: "portable" | "backup") {
  if (!selectedCollectionId.value || !canEdit.value || (kind === "backup" && !bootstrapAdmin.value)) return;
  clearStatus();
  busy.value = true;
  exportProgress.value = { done: 0, total: 0 };
  try {
    const created = await api<{ id: string; manifestHash: string }>(`/api/v1/collections/${selectedCollectionId.value}/export-jobs`, {
      method: "POST",
      ...jsonBody({ kind }),
    });
    const manifestResult = await api<{ manifest: ExportManifest; manifestHash: string }>(`/api/v1/export-jobs/${created.id}/manifest`);
    const manifestText = `${JSON.stringify(manifestResult.manifest, null, 2)}\n`;
    const entries: Array<{ path: string; data: ArrayBuffer | string }> = [{ path: "manifest.json", data: manifestText }];
    exportProgress.value.total = manifestResult.manifest.objects.length;

    for (const object of manifestResult.manifest.objects) {
      const response = await fetch(`/api/v1/export-jobs/${created.id}/objects/${object.id}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`下载导出对象失败：${object.logicalPath}`);
      const buffer = await response.arrayBuffer();
      const hash = await digestHex(buffer);
      if (hash !== object.sha256) throw new Error(`浏览器校验失败：${object.logicalPath}`);
      entries.push({ path: object.logicalPath, data: buffer });
      exportProgress.value.done += 1;
    }

    const zip = await createStoredZip(entries);
    const safeName = selectedCollection.value?.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-") || "knowledge-core";
    downloadBlob(zip, `${safeName}-${kind === "backup" ? "full-backup" : "portable"}.zip`);
    if (kind === "backup") lastBackup.value = { jobId: created.id, manifestHash: created.manifestHash };
    message.value = kind === "backup"
      ? "完整灾备 ZIP 已在浏览器生成。解压后运行 verify:backup，验证成功后再登记 reportHash。"
      : "可移植 Markdown ZIP 已在浏览器生成。";
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="transfer-page">
    <header class="transfer-header">
      <div>
        <p class="eyebrow">Knowledge portability</p>
        <h1>Markdown 导入 / 导出</h1>
        <p>批量写入先 dry-run；完整灾备与普通 Markdown 搬运严格分离。</p>
      </div>
      <label class="collection-picker">
        <span>知识库</span>
        <select v-model="selectedCollectionId" :disabled="busy">
          <option v-for="collection in appStore.collections" :key="collection.id" :value="collection.id">
            {{ collection.name }} · {{ collection.role }}
          </option>
        </select>
      </label>
    </header>

    <p v-if="message" class="transfer-notice" role="status">{{ message }}</p>
    <p v-if="errorMessage" class="transfer-error" role="alert">{{ errorMessage }}</p>

    <div class="transfer-grid">
      <article class="transfer-card">
        <div class="transfer-card__heading">
          <div><span class="step">01</span><h2>导入 Markdown</h2></div>
          <span class="role-chip">{{ canEdit ? 'Editor+' : '只读' }}</span>
        </div>
        <p>文件夹或 ZIP 只在浏览器读取。Worker 会对每篇再次验证路径、UTF-8、frontmatter、大小与敏感凭证。</p>

        <div class="file-actions">
          <label class="button button--secondary">
            选择文件夹
            <input class="sr-only" type="file" multiple webkitdirectory @change="selectFolder">
          </label>
          <label class="button button--secondary">
            选择 ZIP
            <input class="sr-only" type="file" accept=".zip,application/zip" @change="selectZip">
          </label>
          <button class="button button--primary" type="button" :disabled="busy || !canEdit || !prepared.length" @click="startImport">
            上传并生成 dry-run
          </button>
        </div>

        <div v-if="prepared.length" class="transfer-summary">
          <strong>{{ prepared.length }} 篇待上传</strong>
          <span>{{ (prepared.reduce((sum, file) => sum + file.bytes, 0) / 1024 / 1024).toFixed(2) }} MiB</span>
          <span v-if="uploadProgress.total">已上传 {{ uploadProgress.done }}/{{ uploadProgress.total }}</span>
        </div>

        <template v-if="importJob">
          <div class="plan-counts" aria-label="dry-run 统计">
            <span>新增 {{ planCounts.create }}</span>
            <span>更新 {{ planCounts.update }}</span>
            <span>未变化 {{ planCounts.unchanged }}</span>
            <span>冲突 {{ planCounts.conflict + planCounts.conflict_deleted }}</span>
            <span>非法 {{ planCounts.invalid }}</span>
          </div>

          <div class="item-list">
            <div v-for="item in importJob.items" :key="item.id" class="item-row">
              <div>
                <strong>{{ item.relativePath }}</strong>
                <small>{{ item.action }} · {{ item.status }}<template v-if="item.errorCode"> · {{ item.errorCode }}</template></small>
              </div>
              <div v-if="item.action === 'conflict' || item.action === 'conflict_deleted'" class="conflict-controls">
                <select v-model="conflictDecisions[item.id].decision" :disabled="importJob.status !== 'planned'">
                  <option value="skip">跳过</option>
                  <option v-if="item.action !== 'conflict_deleted'" value="overwrite">明确覆盖</option>
                  <option value="copy">保留为新副本</option>
                </select>
                <input
                  v-if="conflictDecisions[item.id].decision === 'copy'"
                  v-model="conflictDecisions[item.id].copyPath"
                  type="text"
                  placeholder="copies/example.md"
                  :disabled="importJob.status !== 'planned'"
                >
              </div>
            </div>
          </div>

          <div class="file-actions">
            <button class="button button--primary" type="button" :disabled="busy || importJob.status !== 'planned'" @click="applyImport">执行已确认项</button>
            <button class="button button--secondary" type="button" :disabled="busy" @click="refreshImport">刷新状态</button>
            <button class="button button--secondary" type="button" :disabled="busy || ['completed', 'cancelled'].includes(importJob.status)" @click="cancelImport">取消未开始项</button>
          </div>
        </template>
      </article>

      <article class="transfer-card">
        <div class="transfer-card__heading">
          <div><span class="step">02</span><h2>导出与灾备</h2></div>
          <span class="role-chip">浏览器组 ZIP</span>
        </div>
        <p><strong>可移植导出</strong>用于 Git / Obsidian / 重新导入；<strong>完整灾备</strong>额外包含回收站、全部不可变历史和恢复元数据。</p>

        <div class="export-options">
          <div>
            <h3>Portable</h3>
            <p>当前 Markdown + 来源及时效字段。不包含历史与回收站。</p>
            <button class="button button--primary" type="button" :disabled="busy || !canEdit" @click="exportZip('portable')">生成可移植 ZIP</button>
          </div>
          <div>
            <h3>Full backup</h3>
            <p>仅 bootstrap 管理员。包含回收站、全部历史与非敏感恢复元数据。</p>
            <button class="button button--secondary" type="button" :disabled="busy || !bootstrapAdmin" @click="exportZip('backup')">生成完整灾备 ZIP</button>
          </div>
        </div>

        <div v-if="exportProgress.total" class="transfer-summary">
          <strong>导出校验</strong><span>{{ exportProgress.done }}/{{ exportProgress.total }} 对象</span>
        </div>

        <div v-if="lastBackup" class="backup-proof">
          <strong>灾备尚未完成验证</strong>
          <p>解压 ZIP 后在仓库执行：</p>
          <code>pnpm verify:backup &lt;解压目录&gt;</code>
          <dl>
            <div><dt>jobId</dt><dd>{{ lastBackup.jobId }}</dd></div>
            <div><dt>manifestHash</dt><dd>{{ lastBackup.manifestHash }}</dd></div>
          </dl>
          <p>本地恢复成功后，将工具输出的 reportHash 登记到该 export job；只有经过验证的完整灾备才能成为未来 purge 的证明。</p>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.transfer-page { display: grid; gap: 22px; padding: 8px 0 48px; }
.transfer-header { display: flex; justify-content: space-between; gap: 24px; align-items: end; }
.transfer-header h1 { margin: 3px 0 6px; font-size: clamp(1.7rem, 4vw, 2.4rem); }
.transfer-header p { margin: 0; color: var(--text-muted); }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: .72rem; font-weight: 700; }
.collection-picker { display: grid; gap: 6px; min-width: min(320px, 100%); }
.collection-picker span { font-size: .78rem; color: var(--text-muted); }
.collection-picker select, .conflict-controls select, .conflict-controls input { width: 100%; border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; background: var(--surface); color: inherit; }
.transfer-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 18px; align-items: start; }
.transfer-card { border: 1px solid var(--border); border-radius: 16px; padding: 20px; background: var(--surface); display: grid; gap: 16px; }
.transfer-card__heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.transfer-card__heading > div { display: flex; align-items: center; gap: 9px; }
.transfer-card h2, .transfer-card h3, .transfer-card p { margin: 0; }
.step, .role-chip { font-size: .72rem; font-weight: 700; border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; }
.file-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.transfer-summary, .plan-counts { display: flex; flex-wrap: wrap; gap: 8px 14px; border-radius: 12px; padding: 11px 13px; background: var(--surface-subtle, rgba(127,127,127,.08)); }
.plan-counts span { font-size: .83rem; }
.item-list { max-height: 430px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
.item-row { padding: 11px 12px; display: grid; grid-template-columns: minmax(0,1fr) minmax(180px,.55fr); gap: 12px; border-bottom: 1px solid var(--border); }
.item-row:last-child { border-bottom: 0; }
.item-row strong, .item-row small { display: block; overflow-wrap: anywhere; }
.item-row small { color: var(--text-muted); margin-top: 3px; }
.conflict-controls { display: grid; gap: 6px; }
.export-options { display: grid; gap: 12px; }
.export-options > div, .backup-proof { border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: grid; gap: 10px; }
.backup-proof code { display: block; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: var(--surface-subtle, rgba(127,127,127,.08)); }
.backup-proof dl { margin: 0; display: grid; gap: 7px; }
.backup-proof dl div { display: grid; grid-template-columns: 110px minmax(0,1fr); gap: 8px; }
.backup-proof dt { color: var(--text-muted); }
.backup-proof dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: .8rem; }
.transfer-notice, .transfer-error { margin: 0; border-radius: 12px; padding: 10px 13px; }
.transfer-notice { background: var(--surface-subtle, rgba(127,127,127,.08)); }
.transfer-error { border: 1px solid currentColor; }
@media (max-width: 860px) {
  .transfer-header { align-items: stretch; flex-direction: column; }
  .transfer-grid { grid-template-columns: 1fr; }
  .item-row { grid-template-columns: 1fr; }
}
</style>
