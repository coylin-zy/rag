import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";
import "./styles.css";

const application = createApp(App).use(createPinia()).use(router);

await router.isReady();
application.mount("#app");
