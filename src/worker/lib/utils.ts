export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function resourceUri(collectionId: string, noteId: string): string {
  return `kb://collections/${collectionId}/notes/${noteId}`;
}

export function excerpt(text: string, maxLength = 360): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}
