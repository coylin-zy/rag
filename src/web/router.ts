import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/knowledge" },
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { title: "登录", layout: "auth" } },
    { path: "/knowledge", name: "knowledge", component: () => import("./views/KnowledgeView.vue"), meta: { title: "知识库" } },
    { path: "/knowledge/:collectionId", name: "collection", component: () => import("./views/KnowledgeView.vue"), meta: { title: "知识库" } },
    { path: "/knowledge/:collectionId/notes/:noteId", name: "note", component: () => import("./views/KnowledgeView.vue"), meta: { title: "知识库" } },
    { path: "/search", name: "search", component: () => import("./views/SearchView.vue"), meta: { title: "检索调试" } },
    { path: "/proposals", name: "proposals", component: () => import("./views/ProposalsView.vue"), meta: { title: "记忆审核" } },
    { path: "/tokens", name: "tokens", component: () => import("./views/TokensView.vue"), meta: { title: "MCP Token" } },
    { path: "/jobs", name: "jobs", component: () => import("./views/JobsView.vue"), meta: { title: "索引任务" } },
    { path: "/:pathMatch(.*)*", redirect: "/knowledge" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
