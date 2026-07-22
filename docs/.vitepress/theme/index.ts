import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import DownloadButton from "./DownloadButton.vue";
import "./custom.css";

// index.md's hero.actions is deliberately EMPTY now — VPHome only forwards
// a fixed slot list up from VPHero (confirmed by reading the installed
// vitepress package's own VPHome.vue: home-hero-info-before/-info/-after,
// home-hero-actions-after, home-hero-image — NOT home-hero-actions-
// before-actions, which VPHero.vue itself defines but VPHome never
// re-exposes), so there's no slot that lands INSIDE the same flex row as
// the framework's own action buttons. Cheaper than fighting that: render
// the ENTIRE actions row ourselves (DownloadButton's own template
// reproduces `.actions`/`.action`/`.VPButton` — the exact classes/CSS
// VPHero.vue's own scoped styles already define — for the two plain
// "Features"/"View on GitHub" links) via home-hero-info-after, the one
// slot that lands in the right place: right after the tagline, exactly
// where `.actions` normally renders.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-info-after": () => h(DownloadButton) }),
};
