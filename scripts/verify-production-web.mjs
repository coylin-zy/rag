const siteUrl = new URL(process.argv[2] ?? "https://rag.coylin.com/");
const workerHealthUrl = new URL(process.argv[3] ?? "https://rag-api.coylin.com/healthz");

function fail(message) {
  console.error(`[verify:production:web] ${message}`);
  process.exit(1);
}

if (siteUrl.protocol !== "https:" || workerHealthUrl.protocol !== "https:") {
  fail("Production verification requires HTTPS URLs.");
}

async function request(url) {
  let response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${url} request failed: ${message}`);
  }
  return response;
}

const indexResponse = await request(siteUrl);
if (indexResponse.status !== 200) fail(`${siteUrl} returned ${indexResponse.status}, expected 200.`);
if (!indexResponse.headers.get("content-type")?.toLowerCase().includes("text/html")) {
  fail(`${siteUrl} did not return text/html.`);
}

const html = await indexResponse.text();
if (!/<div\s+id=["']app["'][^>]*><\/div>/i.test(html)) fail("Production index.html has no Vue #app mount element.");

const assetPattern = /\b(?:src|href)=["'](?<url>\/assets\/[^"'?#\s<>]+)(?:[?#][^"']*)?["']/gi;
const assets = [...new Set(
  [...html.matchAll(assetPattern)].map((match) => match.groups.url),
)].sort();

if (assets.length === 0) fail("Production index.html references no built assets.");

await Promise.all(assets.map(async (asset) => {
  const url = new URL(asset, siteUrl);
  const response = await request(url);
  if (response.status !== 200) fail(`${url} returned ${response.status}, expected 200.`);

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (asset.endsWith(".js") && !contentType.includes("javascript")) {
    fail(`${url} returned unexpected Content-Type ${contentType || "<missing>"}.`);
  }
  if (asset.endsWith(".css") && !contentType.includes("text/css")) {
    fail(`${url} returned unexpected Content-Type ${contentType || "<missing>"}.`);
  }
}));

const sessionUrl = new URL("/api/v1/session", siteUrl);
const sessionResponse = await request(sessionUrl);
if (sessionResponse.status !== 401) {
  fail(`${sessionUrl} returned ${sessionResponse.status}, expected unauthenticated 401.`);
}

const healthResponse = await request(workerHealthUrl);
if (healthResponse.status !== 200) fail(`${workerHealthUrl} returned ${healthResponse.status}, expected 200.`);
if (!healthResponse.headers.get("content-type")?.toLowerCase().includes("application/json")) {
  fail(`${workerHealthUrl} did not return application/json.`);
}

console.log(`[verify:production:web] ${siteUrl} returned 200 with ${assets.length} healthy assets.`);
console.log("[verify:production:web] Unauthenticated session returned 401 and Worker health returned 200.");
