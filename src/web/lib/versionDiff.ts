import { parse as parseYaml } from "yaml";

export type DiffKind = "equal" | "remove" | "add" | "truncated";

export interface DiffRow {
  kind: DiffKind;
  oldLine: number | null;
  newLine: number | null;
  oldText: string;
  newText: string;
}

export interface ParsedVersionDocument {
  id: string | null;
  metadata: Record<string, unknown>;
  body: string;
}

export interface VersionDiffResult {
  metadataBefore: Record<string, unknown>;
  metadataAfter: Record<string, unknown>;
  identityMismatch: boolean;
  rows: DiffRow[];
  truncated: boolean;
}

const MAX_RENDER_ROWS = 1600;
const MAX_LCS_CELLS = 300_000;

export function parseVersionDocument(markdown: string): ParsedVersionDocument {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let raw: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  const id = typeof raw.id === "string" ? raw.id : null;
  const metadata = { ...raw };
  delete metadata.id;
  delete metadata.version;
  return {
    id,
    metadata,
    body: match ? markdown.slice(match[0].length).replace(/^\r?\n/, "") : markdown,
  };
}

function commonPrefix(left: string[], right: string[]) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffix(left: string[], right: string[], prefix: number) {
  let count = 0;
  while (
    count < left.length - prefix
    && count < right.length - prefix
    && left[left.length - 1 - count] === right[right.length - 1 - count]
  ) count += 1;
  return count;
}

function lcsRows(left: string[], right: string[], oldOffset: number, newOffset: number): DiffRow[] {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      table[index] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ kind: "equal", oldLine: oldOffset + i + 1, newLine: newOffset + j + 1, oldText: left[i], newText: right[j] });
      i += 1;
      j += 1;
      continue;
    }
    if (j < right.length && (i >= left.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      rows.push({ kind: "add", oldLine: null, newLine: newOffset + j + 1, oldText: "", newText: right[j] });
      j += 1;
      continue;
    }
    rows.push({ kind: "remove", oldLine: oldOffset + i + 1, newLine: null, oldText: left[i], newText: "" });
    i += 1;
  }
  return rows;
}

function coarseRows(left: string[], right: string[], oldOffset: number, newOffset: number): DiffRow[] {
  return [
    ...left.map((text, index): DiffRow => ({ kind: "remove", oldLine: oldOffset + index + 1, newLine: null, oldText: text, newText: "" })),
    ...right.map((text, index): DiffRow => ({ kind: "add", oldLine: null, newLine: newOffset + index + 1, oldText: "", newText: text })),
  ];
}

function limitRows(rows: DiffRow[]): { rows: DiffRow[]; truncated: boolean } {
  if (rows.length <= MAX_RENDER_ROWS) return { rows, truncated: false };
  const headCount = Math.floor((MAX_RENDER_ROWS - 1) / 2);
  const tailCount = MAX_RENDER_ROWS - 1 - headCount;
  return {
    rows: [
      ...rows.slice(0, headCount),
      { kind: "truncated", oldLine: null, newLine: null, oldText: "", newText: "差异过大，中间内容已折叠" },
      ...rows.slice(rows.length - tailCount),
    ],
    truncated: true,
  };
}

export function buildVersionDiff(beforeMarkdown: string, afterMarkdown: string): VersionDiffResult {
  const before = parseVersionDocument(beforeMarkdown);
  const after = parseVersionDocument(afterMarkdown);
  const left = before.body.replace(/\r\n/g, "\n").split("\n");
  const right = after.body.replace(/\r\n/g, "\n").split("\n");
  const prefix = commonPrefix(left, right);
  const suffix = commonSuffix(left, right, prefix);

  const rows: DiffRow[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ kind: "equal", oldLine: index + 1, newLine: index + 1, oldText: left[index], newText: right[index] });
  }

  const leftMiddle = left.slice(prefix, left.length - suffix || left.length);
  const rightMiddle = right.slice(prefix, right.length - suffix || right.length);
  const middle = leftMiddle.length * rightMiddle.length <= MAX_LCS_CELLS
    ? lcsRows(leftMiddle, rightMiddle, prefix, prefix)
    : coarseRows(leftMiddle, rightMiddle, prefix, prefix);
  rows.push(...middle);

  for (let index = suffix; index > 0; index -= 1) {
    const oldIndex = left.length - index;
    const newIndex = right.length - index;
    rows.push({
      kind: "equal",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      oldText: left[oldIndex],
      newText: right[newIndex],
    });
  }

  const limited = limitRows(rows);
  return {
    metadataBefore: before.metadata,
    metadataAfter: after.metadata,
    identityMismatch: Boolean(before.id && after.id && before.id !== after.id),
    rows: limited.rows,
    truncated: limited.truncated,
  };
}
