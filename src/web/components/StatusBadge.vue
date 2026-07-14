<script setup lang="ts">
const props = defineProps<{ status: string }>();
const labels: Record<string, string> = {
  published: "已发布",
  draft: "草稿",
  deleted: "已删除",
  queued: "排队中",
  processing: "处理中",
  ready: "已完成",
  failed: "失败",
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};
</script>

<template>
  <span class="status-badge" :class="`status-badge--${props.status}`">
    <span aria-hidden="true" />{{ labels[props.status] ?? props.status }}
  </span>
</template>
