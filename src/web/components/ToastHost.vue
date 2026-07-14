<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from "@lucide/vue";

import { useToastStore } from "@web/stores/toast";

const toast = useToastStore();
const icons = { success: CircleCheck, error: CircleAlert, info: Info };
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <div v-for="item in toast.messages" :key="item.id" class="toast" :class="`toast--${item.type}`">
      <component :is="icons[item.type]" :size="19" />
      <span>{{ item.message }}</span>
      <button class="icon-button icon-button--small" type="button" aria-label="关闭通知" @click="toast.dismiss(item.id)">
        <X :size="17" />
      </button>
    </div>
  </div>
</template>
