import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = process.cwd();
const vitestArgs = process.argv.slice(2);

function runPnpm(args, cwd) {
  const pnpmEntrypoints = [
    process.env.npm_execpath,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : undefined,
  ];
  const pnpmEntrypoint = pnpmEntrypoints.find((candidate) => candidate && existsSync(candidate));
  const result = pnpmEntrypoint
    ? spawnSync(process.execPath, [pnpmEntrypoint, ...args], { cwd, stdio: "inherit" })
    : spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runVitest(cwd) {
  return runPnpm(["exec", "vitest", ...(vitestArgs.length ? vitestArgs : ["run"])], cwd);
}

function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (stat.isFile()) copyFileSync(source, destination);
}

if (process.platform !== "win32" || /^[\x00-\x7F]+$/.test(sourceRoot)) {
  process.exit(runVitest(sourceRoot));
}

if (vitestArgs.includes("--watch")) {
  throw new Error("Cloudflare Workers Vitest cannot watch a Windows workspace whose path contains non-ASCII characters. Move the project to an ASCII path for watch mode.");
}

// workers-sdk#14655: workerd loses cloudflare:test-internal on non-ASCII Windows paths.
// Run an isolated, secret-free mirror on the same drive until upstream fixes the issue.
const driveRoot = path.parse(sourceRoot).root;
const tempParent = /^[\x00-\x7F]+$/.test(driveRoot) ? driveRoot : os.tmpdir();
const tempRoot = mkdtempSync(path.join(tempParent, "knowledge-core-vitest-"));
const excluded = new Set([
  ".git",
  ".wrangler",
  ".wrangler-dist",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

try {
  console.log(`[test] Preparing Cloudflare Windows path workaround: ${tempRoot}`);
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name === ".dev.vars" || (entry.name.startsWith(".env") && !entry.name.endsWith(".example"))) continue;
    copyTree(path.join(sourceRoot, entry.name), path.join(tempRoot, entry.name));
  }
  console.log(`[test] Cloudflare Windows path workaround: ${tempRoot}`);
  const installStatus = runPnpm(["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], tempRoot);
  process.exitCode = installStatus === 0 ? runVitest(tempRoot) : installStatus;
} finally {
  if (path.basename(tempRoot).startsWith("knowledge-core-vitest-") && path.dirname(tempRoot) === path.resolve(tempParent)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
