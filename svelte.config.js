import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Svelte 5 (runes). vitePreprocess enables <script lang="ts"> in components
// and *.svelte.ts controller modules.
export default {
  preprocess: vitePreprocess(),
};
