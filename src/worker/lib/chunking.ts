import { deterministicId, sha256 } from "./crypto";
import { stripFrontmatter } from "./markdown";

export interface MarkdownChunk {
  id: string;
  ordinal: number;
  headingPath: string[];
  content: string;
  contentHash: string;
  embeddingText: string;
}

interface Section {
  headings: string[];
  content: string;
}

const MAX_CHARS = 1500;
const OVERLAP_CHARS = 150;

function codePoints(value: string): string[] {
  return Array.from(value);
}

function charLength(value: string): number {
  return codePoints(value).length;
}

function sliceChars(value: string, start: number, end?: number): string {
  return codePoints(value).slice(start, end).join("");
}

function tailChars(value: string, length: number): string {
  const characters = codePoints(value);
  return characters.slice(Math.max(0, characters.length - length)).join("");
}

function markdownBlocks(content: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  const flush = () => {
    const block = lines.join("\n").trim();
    if (block) blocks.push(block);
    lines = [];
  };

  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      lines.push(line);
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length) {
        fence = null;
        flush();
      }
      continue;
    }

    if (match) {
      flush();
      fence = { marker: match[1][0], length: match[1].length };
      lines.push(line);
    } else if (!line.trim()) {
      flush();
    } else {
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

function sectionize(markdown: string): Section[] {
  const sections: Section[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) sections.push({ headings: headings.filter(Boolean), content });
    lines = [];
  };

  for (const line of stripFrontmatter(markdown).split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    const heading = fence ? null : line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2].replace(/\s+#+$/, "").trim();
      lines.push(line);
    } else {
      lines.push(line);
    }

    if (!fence && fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
    } else if (fence && fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) {
      fence = null;
    }
  }
  flush();
  return sections;
}

function splitSection(section: Section): string[] {
  if (charLength(section.content) <= MAX_CHARS) return [section.content];

  const blocks = markdownBlocks(section.content);
  const results: string[] = [];
  let current = "";

  const pushCurrent = (): string => {
    if (!current.trim()) return "";
    const completed = current.trim();
    results.push(completed);
    current = "";
    return completed;
  };

  for (const block of blocks) {
    if (charLength(block) > MAX_CHARS) {
      pushCurrent();
      const length = charLength(block);
      for (let start = 0; start < length; start += MAX_CHARS - OVERLAP_CHARS) {
        results.push(sliceChars(block, start, start + MAX_CHARS).trim());
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;
    if (charLength(candidate) <= MAX_CHARS) {
      current = candidate;
      continue;
    }

    const previous = pushCurrent();
    const separatorLength = 2;
    const availableOverlap = Math.max(0, MAX_CHARS - charLength(block) - separatorLength);
    const overlap = previous ? tailChars(previous, Math.min(OVERLAP_CHARS, availableOverlap)) : "";
    current = overlap ? `${overlap}\n\n${block}` : block;
  }
  pushCurrent();
  return results.filter(Boolean).filter((item, index, all) => index === 0 || item !== all[index - 1]);
}

export async function chunkMarkdown(input: {
  noteId: string;
  version: number;
  title: string;
  markdown: string;
}): Promise<MarkdownChunk[]> {
  const pieces = sectionize(input.markdown).flatMap((section) =>
    splitSection(section).map((content) => ({ headingPath: section.headings, content })),
  );

  return Promise.all(
    pieces.map(async (piece, ordinal) => ({
      id: await deterministicId(`${input.noteId}:${input.version}:${ordinal}`),
      ordinal,
      headingPath: piece.headingPath,
      content: piece.content,
      contentHash: await sha256(piece.content),
      embeddingText: [input.title, piece.headingPath.join(" > "), piece.content].filter(Boolean).join("\n"),
    })),
  );
}
