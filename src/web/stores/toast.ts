import { defineStore } from "pinia";
import { ref } from "vue";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

export const useToastStore = defineStore("toast", () => {
  const messages = ref<ToastMessage[]>([]);

  function show(message: string, type: ToastMessage["type"] = "info") {
    const id = crypto.randomUUID();
    messages.value.push({ id, type, message });
    window.setTimeout(() => dismiss(id), 4500);
  }

  function dismiss(id: string) {
    messages.value = messages.value.filter((item) => item.id !== id);
  }

  return { messages, show, dismiss };
});
