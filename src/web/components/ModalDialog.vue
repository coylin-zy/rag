<script setup lang="ts">
import { X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";

const props = defineProps<{ title: string; description?: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const titleId = useId();
const descriptionId = useId();
let previousFocus: HTMLElement | null = null;

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return [];
  return [...dialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute("hidden"));
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.addEventListener("keydown", onKeydown);
  await nextTick();
  const preferred = dialog.value?.querySelector<HTMLElement>("[autofocus]") ?? focusableElements()[0] ?? dialog.value;
  preferred?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  previousFocus?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-layer" role="presentation" @mousedown.self="emit('close')">
      <section ref="dialog" class="modal-dialog" :class="{ 'modal-dialog--wide': props.wide }" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="description ? descriptionId : undefined" tabindex="-1">
        <header class="modal-header">
          <div>
            <h2 :id="titleId">{{ title }}</h2>
            <p v-if="description" :id="descriptionId">{{ description }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><X :size="20" /></button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
