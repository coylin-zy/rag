import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const FORBIDDEN_RECOVERY_KEYS = new Set([
  "token",
  "rawToken",
  "tokenHash",
  "token_hash",
  "password",
  "passwordHash",
  "password_hash",
  "session",
  "sessionSecret",
  "session_secret",
  "apiKey",
  "api_key",
  "secret",
]);

function usage() {
  console.error("Usage: pnpm verify:backup <extracted-backup-dir> [--fixture <empty-output-dir>]");
  process.exit(2);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeLogicalPath(logicalPath) {
  if (typeof logicalPath !== "string" || !logicalPath || logicalPath.includes("\\")) {
    throw new Error(`Invalid manifest logical path: ${String(logicalPath)}`);
  }
  const normalized = path.posix.normalize(logicalPath);
  if (normalized !== logicalPath || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe manifest logical path: ${logicalPath}`);
  }
  return normalized;
}

function inspectForbiddenKeys(value, location = "recovery") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForbiddenKeys(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECOVERY_KEYS.has(key)) throw new Error(`Sensitive recovery key ${key} found at ${location}`);
    inspectForbiddenKeys(child, `${location}.${key}`);
  }
}

function createFixtureDb(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      created_at TEXT, updated_at TEXT, created_by TEXT,
      trashed_at TEXT, trashed_by TEXT, trash_reason TEXT, purge_after TEXT
    );
    CREATE TABLE memberships (
      collection_id TEXT NOT NULL, user_email TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT,
      PRIMARY KEY(collection_id, user_email)
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, title TEXT NOT NULL,
      tags_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      indexed_version INTEGER, content_hash TEXT NOT NULL,
      created_at TEXT, updated_at TEXT, created_by TEXT, updated_by TEXT,
      deleted_at TEXT, deleted_from_status TEXT, deleted_by TEXT, delete_reason TEXT,
      source_json TEXT, observed_at TEXT, reviewed_at TEXT, review_after TEXT,
      supersedes_json TEXT, external_path TEXT, sync_base_hash TEXT
    );
    CREATE TABLE note_versions (
      note_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      title TEXT NOT NULL, tags_json TEXT NOT NULL, created_at TEXT, created_by TEXT,
      restored_r2_key TEXT NOT NULL,
      PRIMARY KEY(note_id, version)
    );
  `);
  return db;
}

function value(record, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

function restoreMetadata(db, collectionId, collectionRecovery, notes, versions) {
  const collection = collectionRecovery.collection;
  if (!collection || collection.id !== collectionId) throw new Error("Recovery collection metadata does not match manifest collection");

  db.prepare(`
    INSERT INTO collections (
      id, name, description, created_at, updated_at, created_by,
      trashed_at, trashed_by, trash_reason, purge_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    collection.id,
    collection.name,
    collection.description ?? "",
    value(collection, "createdAt"),
    value(collection, "updatedAt"),
    value(collection, "createdBy"),
    value(collection, "trashedAt"),
    value(collection, "trashedBy"),
    value(collection, "trashReason"),
    value(collection, "purgeAfter"),
  );

  const membershipInsert = db.prepare(`
    INSERT INTO memberships (collection_id, user_email, role, created_at) VALUES (?, ?, ?, ?)
  `);
  for (const membership of collectionRecovery.memberships ?? []) {
    membershipInsert.run(collectionId, membership.email, membership.role, membership.createdAt ?? null);
  }

  const noteInsert = db.prepare(`
    INSERT INTO notes (
      id, collection_id, title, tags_json, status, version, indexed_version, content_hash,
      created_at, updated_at, created_by, updated_by,
      deleted_at, deleted_from_status, deleted_by, delete_reason,
      source_json, observed_at, reviewed_at, review_after, supersedes_json,
      external_path, sync_base_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const note of notes) {
    if (note.collectionId !== collectionId) throw new Error(`Note ${note.id} belongs to an unexpected collection`);
    noteInsert.run(
      note.id,
      note.collectionId,
      note.title,
      note.tagsJson ?? "[]",
      note.status,
      note.version,
      note.indexedVersion ?? null,
      note.contentHash,
      note.createdAt ?? null,
      note.updatedAt ?? null,
      note.createdBy ?? null,
      note.updatedBy ?? null,
      note.deletedAt ?? null,
      note.deletedFromStatus ?? null,
      note.deletedBy ?? null,
      note.deleteReason ?? null,
      note.sourceJson ?? null,
      note.observedAt ?? null,
      note.reviewedAt ?? null,
      note.reviewAfter ?? null,
      note.supersedesJson ?? null,
      note.externalPath ?? null,
      note.syncBaseHash ?? null,
    );
  }

  const versionInsert = db.prepare(`
    INSERT INTO note_versions (
      note_id, version, content_hash, title, tags_json, created_at, created_by, restored_r2_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const version of versions) {
    const r2Key = `versions/${collectionId}/${version.noteId}/${version.version}.md`;
    versionInsert.run(
      version.noteId,
      version.version,
      version.contentHash,
      version.title,
      version.tagsJson ?? "[]",
      version.createdAt ?? null,
      version.createdBy ?? null,
      r2Key,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0]) usage();
  const sourceDir = path.resolve(args[0]);
  const fixtureFlag = args.indexOf("--fixture");
  const fixtureDir = fixtureFlag >= 0
    ? path.resolve(args[fixtureFlag + 1] || usage())
    : await mkdtemp(path.join(os.tmpdir(), "knowledge-core-backup-verify-"));

  const manifestBytes = await readFile(path.join(sourceDir, "manifest.json"));
  const manifestHash = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.formatVersion !== 1 || manifest.kind !== "full_backup") {
    throw new Error("verify-backup only accepts Knowledge Core full_backup formatVersion 1");
  }
  if (!manifest.includesHistory || !manifest.includesTrash) {
    throw new Error("Full backup must include both immutable history and trash metadata");
  }
  if (!manifest.collection?.id) throw new Error("Manifest is missing collection.id");
  if (!Array.isArray(manifest.objects)) throw new Error("Manifest is missing objects[]");

  const objectBytes = new Map();
  for (const object of manifest.objects) {
    const logicalPath = safeLogicalPath(object.logicalPath);
    const filename = path.join(sourceDir, ...logicalPath.split("/"));
    const bytes = await readFile(filename);
    if (bytes.byteLength !== object.byteSize) throw new Error(`Byte size mismatch: ${logicalPath}`);
    const actualHash = sha256(bytes);
    if (actualHash !== object.sha256) throw new Error(`SHA-256 mismatch: ${logicalPath}`);
    objectBytes.set(logicalPath, bytes);
  }

  const requiredRecovery = ["recovery/collections.json", "recovery/notes.json", "recovery/versions.json"];
  for (const required of requiredRecovery) {
    if (!objectBytes.has(required)) throw new Error(`Full backup is missing ${required}`);
  }
  const collectionRecovery = JSON.parse(objectBytes.get("recovery/collections.json").toString("utf8"));
  const notes = JSON.parse(objectBytes.get("recovery/notes.json").toString("utf8"));
  const versions = JSON.parse(objectBytes.get("recovery/versions.json").toString("utf8"));
  inspectForbiddenKeys(collectionRecovery);
  inspectForbiddenKeys(notes);
  inspectForbiddenKeys(versions);
  if (!Array.isArray(notes) || !Array.isArray(versions)) throw new Error("Recovery notes/versions metadata is malformed");

  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(path.join(fixtureDir, "r2", "versions"), { recursive: true });
  await mkdir(path.join(fixtureDir, "r2", "notes"), { recursive: true });
  const db = createFixtureDb(path.join(fixtureDir, "d1.sqlite"));
  restoreMetadata(db, manifest.collection.id, collectionRecovery, notes, versions);

  const versionByKey = new Map();
  for (const version of versions) {
    const logicalPath = `history/${version.noteId}/${version.version}.md`;
    const bytes = objectBytes.get(logicalPath);
    if (!bytes) throw new Error(`Missing immutable history object ${logicalPath}`);
    if (sha256(bytes) !== version.contentHash) throw new Error(`History metadata hash mismatch ${logicalPath}`);
    const r2Path = path.join(fixtureDir, "r2", "versions", manifest.collection.id, version.noteId, `${version.version}.md`);
    await mkdir(path.dirname(r2Path), { recursive: true });
    await writeFile(r2Path, bytes);
    versionByKey.set(`${version.noteId}:${version.version}`, bytes);
  }

  for (const note of notes) {
    const currentBytes = versionByKey.get(`${note.id}:${note.version}`);
    if (!currentBytes) throw new Error(`Current version is missing from history for note ${note.id}`);
    if (sha256(currentBytes) !== note.contentHash) throw new Error(`Current note hash mismatch for ${note.id}`);
    const currentPath = path.join(fixtureDir, "r2", "notes", manifest.collection.id, note.id, "current.md");
    await mkdir(path.dirname(currentPath), { recursive: true });
    await writeFile(currentPath, currentBytes);
  }

  const restoredCollectionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM collections").get().count);
  const restoredNoteCount = Number(db.prepare("SELECT COUNT(*) AS count FROM notes").get().count);
  const restoredVersionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM note_versions").get().count);
  const brokenCurrent = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM notes n
    LEFT JOIN note_versions v ON v.note_id = n.id AND v.version = n.version
    WHERE v.note_id IS NULL OR v.content_hash != n.content_hash
  `).get().count);
  db.close();
  if (restoredCollectionCount !== 1 || brokenCurrent !== 0) throw new Error("Restored D1 fixture failed consistency checks");

  const reportBase = {
    formatVersion: 1,
    verifier: "knowledge-core/verify-backup",
    manifestHash,
    collectionId: manifest.collection.id,
    objectCount: manifest.objects.length,
    restoredCollectionCount,
    restoredNoteCount,
    restoredVersionCount,
    verifiedAt: new Date().toISOString(),
  };
  const canonicalReport = `${JSON.stringify(reportBase, null, 2)}\n`;
  const reportHash = sha256(Buffer.from(canonicalReport));
  const report = { ...reportBase, reportHash };
  await writeFile(path.join(fixtureDir, "verification-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ ...report, fixtureDir }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
