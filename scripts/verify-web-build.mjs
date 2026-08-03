import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const buildRoot = path.resolve(process.cwd(), process.argv[2] ?? "dist");
const indexPath = path.join(buildRoot, "index.html");

function fail(message) {
  console.error(`[verify:web-build] ${message}`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(indexPath, "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Cannot read ${indexPath}: ${message}`);
}

if (!/<div\s+id=["']app["'][^>]*><\/div>/i.test(html)) {
  fail("index.html does not contain the Vue #app mount element.");
}

if (!/<script\b[^>]*\btype=["']module["'][^>]*>/i.test(html)) {
  fail("index.html does not contain a module entry script.");
}

const assetPattern = /\b(?:src|href)=["'](?<url>\/assets\/[^"'?#\s<>]+)(?:[?#][^"']*)?["']/gi;
const assets = [...new Set(
  [...html.matchAll(assetPattern)].map((match) => match.groups.url),
)].sort();

if (assets.length === 0) fail("index.html does not reference any built assets.");
if (!assets.some((asset) => asset.endsWith(".js"))) fail("index.html has no JavaScript entry asset.");
if (!assets.some((asset) => asset.endsWith(".css"))) fail("index.html has no stylesheet asset.");

for (const asset of assets) {
  const relativePath = asset.slice(1).split("/").join(path.sep);
  const resolvedPath = path.resolve(buildRoot, relativePath);
  const rootPrefix = `${buildRoot}${path.sep}`;

  if (!resolvedPath.startsWith(rootPrefix)) fail(`Asset escapes build root: ${asset}`);

  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    fail(`Referenced asset is missing: ${asset}`);
  }

  if (!stat.isFile() || stat.size === 0) fail(`Referenced asset is empty or not a file: ${asset}`);
}

console.log(`[verify:web-build] Verified index.html and ${assets.length} referenced assets.`);
