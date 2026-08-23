import { expect, test, type APIRequestContext, type Locator, type Page } from "playwright/test";

const DEV_HEADERS = { "x-dev-user-email": "admin@example.com" };

async function navigate(page: Page, label: string) {
  const menu = page.getByRole("button", { name: "打开导航" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name: label, exact: true }).click();
}

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.locator("html").evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);
}

async function expectCenterHitTarget(locator: Locator) {
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
}

async function openMobileKnowledgeLibrary(page: Page) {
  const libraryTrigger = page.getByTestId("mobile-library-trigger");
  if (await libraryTrigger.isVisible() && await libraryTrigger.getAttribute("aria-expanded") !== "true") {
    await libraryTrigger.click();
  }
}

async function clickKnowledgeAction(page: Page, primaryTestId: string, sidebarTestId: string) {
  const primary = page.getByTestId(primaryTestId);
  if (await primary.isVisible()) {
    await primary.click();
    return;
  }
  const libraryTrigger = page.getByTestId("mobile-library-trigger");
  await expect(libraryTrigger).toBeVisible();
  await openMobileKnowledgeLibrary(page);
  const sidebar = page.getByTestId(sidebarTestId);
  await expect(sidebar).toBeVisible();
  await sidebar.click();
}

async function mcpCall(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const response = await request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    data: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json() as {
    result?: { structuredContent?: { result?: unknown }; isError?: boolean };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result?.structuredContent?.result;
}

test("knowledge, retrieval, token and reviewed-memory workflow", async ({ page, request }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));

  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const collectionName = `E2E Knowledge ${suffix}`;
  const noteTitle = `部署手册 ${suffix}`;
  const marker = `CF-${Date.now()}`;
  const proposalTitle = `Agent Memory ${suffix}`;
  const proposalMarker = `MEMORY-${Date.now()}`;

  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await page.getByLabel("管理员邮箱").fill("admin@coylin.com");
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "进入知识工作区", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("邮箱或密码错误");
  await page.getByLabel("密码").fill("password");
  await page.getByRole("button", { name: "进入知识工作区", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  runtimeErrors.length = 0;
  await expect(page.locator(".knowledge-shell")).toBeVisible();
  await expectNoPageOverflow(page);

  await clickKnowledgeAction(page, "create-collection-primary", "create-collection-sidebar");
  let dialog = page.getByRole("dialog", { name: "新建知识库" });
  await expect(dialog.getByLabel("名称")).toBeFocused();
  await expectNoPageOverflow(page);
  await dialog.getByLabel("名称").fill(collectionName);
  await dialog.getByLabel("描述").fill("Playwright end-to-end collection");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]+$/);
  const collectionId = page.url().split("/").pop() ?? "";

  await clickKnowledgeAction(page, "create-note-primary", "create-note-sidebar");
  dialog = page.getByRole("dialog", { name: "新建 Markdown" });
  await expect(dialog.getByLabel("标题")).toBeFocused();
  await dialog.getByLabel("标题").fill(noteTitle);
  await dialog.getByLabel("标签").fill("Cloudflare, MCP, 编号");
  await dialog.getByRole("button", { name: "创建并编辑" }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]+$/);

  const editor = page.getByRole("textbox", { name: "Markdown 内容" });
  const initialMarkdown = await editor.inputValue();
  await editor.fill(`${initialMarkdown.trim()}\n\n生产部署精确编号：${marker}\n\n## Queue\n\n使用 Queue 异步建立索引。\n`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存，索引任务已排队")).toBeVisible();
  const mobilePreviewTrigger = page.getByTestId("mobile-preview-trigger");
  if (await mobilePreviewTrigger.isVisible()) {
    await mobilePreviewTrigger.click();
  }
  await expect(page.locator(".markdown-preview")).toContainText(marker);
  await expect(page.locator(".markdown-preview")).not.toContainText("status: published");

  await page.getByRole("button", { name: "版本记录" }).click();
  dialog = page.getByRole("dialog", { name: "版本记录" });
  await expect(dialog.getByText(/版本 2/)).toBeVisible();
  await expect(dialog.getByText("版本 1")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();

  await expect.poll(async () => {
    const response = await request.post("/api/v1/search", {
      headers: DEV_HEADERS,
      data: { query: marker, collectionIds: [collectionId], tags: [], limit: 8 },
    });
    if (!response.ok()) return 0;
    const body = await response.json() as { data?: Array<{ title: string }> };
    return body.data?.filter((result) => result.title === noteTitle).length ?? 0;
  }, { timeout: 25_000, intervals: [500, 1_000, 2_000] }).toBe(1);

  await navigate(page, "检索调试");
  await page.getByRole("searchbox", { name: "检索问题" }).fill(marker);
  await page.getByRole("button", { name: "检索" }).click();
  await expect(page.getByRole("link", { name: noteTitle })).toBeVisible();
  await expect(page.getByText(/kb:\/\/collections\//)).toBeVisible();

  await navigate(page, "MCP Token");
  const createTokenButton = page.getByRole("button", { name: "创建 Token" });
  await expect(createTokenButton).toBeVisible();
  await expectNoPageOverflow(page);
  await expectCenterHitTarget(createTokenButton);
  await createTokenButton.click();
  dialog = page.getByRole("dialog", { name: "创建 MCP Token" });
  await dialog.getByLabel("名称").fill(`Codex ${suffix}`);
  const collectionGroup = dialog.getByRole("group", { name: "知识库" });
  for (const checkbox of await collectionGroup.getByRole("checkbox").all()) {
    const name = await checkbox.getAttribute("aria-label") ?? await checkbox.evaluate((element) => element.parentElement?.textContent?.trim() ?? "");
    if (name === collectionName) await checkbox.check();
    else await checkbox.uncheck();
  }
  await dialog.getByRole("checkbox", { name: "提交待审核记忆" }).check();
  await dialog.getByRole("button", { name: "创建", exact: true }).click();

  dialog = page.getByRole("dialog", { name: "Token 已创建" });
  const token = (await dialog.locator("code").textContent())?.trim() ?? "";
  expect(token).toMatch(/^kcore_[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole("button", { name: "我已保存" }).click();

  const proposal = await mcpCall(request, token, "propose_memory", {
    collection_id: collectionId,
    title: proposalTitle,
    body: `${proposalMarker} must be approved by a human.`,
    tags: ["agent", "e2e"],
    source: `playwright:${testInfo.project.name}`,
  }) as { id: string; status: string };
  expect(proposal.status).toBe("pending");

  const beforeApproval = await mcpCall(request, token, "search_knowledge", {
    query: proposalMarker,
    collection_ids: [collectionId],
    limit: 8,
  }) as unknown[];
  expect(beforeApproval).toEqual([]);

  await navigate(page, "记忆审核");
  await page.getByRole("button", { name: new RegExp(proposalTitle) }).click();
  const preview = page.locator("article.proposal-markdown");
  await expect(preview).toContainText(proposalMarker);
  await expect(preview).not.toContainText("status: draft");
  await page.getByRole("button", { name: "批准并发布" }).click();
  dialog = page.getByRole("dialog", { name: "批准记忆提案" });
  await dialog.getByLabel("审核备注").fill("Playwright verified");
  await dialog.getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".proposal-title-line").getByText("已通过")).toBeVisible();

  await expect.poll(async () => {
    const results = await mcpCall(request, token, "search_knowledge", {
      query: proposalMarker,
      collection_ids: [collectionId],
      limit: 8,
    }) as Array<{ title: string; resourceUri: string }>;
    return results.find((result) => result.title === proposalTitle)?.resourceUri ?? "";
  }, { timeout: 25_000, intervals: [500, 1_000, 2_000] }).toMatch(/^kb:\/\/collections\//);

  await navigate(page, "知识库");
  await openMobileKnowledgeLibrary(page);
  await page.getByRole("button", { name: new RegExp(collectionName) }).click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/${collectionId}$`));
  await openMobileKnowledgeLibrary(page);
  await expect(page.getByRole("button", { name: new RegExp(proposalTitle) })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});
