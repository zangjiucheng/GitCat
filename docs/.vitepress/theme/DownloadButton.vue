<!--
  Replaces index.md's old plain "Download" hero button (a static link to
  the bare /releases page) with an OS-auto-detecting split button, styled
  after the reference screenshot the request was built from: one big
  "Download beta for <platform>" button plus a chevron opening a dropdown of
  every other build, each with its own small platform icon, a "· Beta"
  suffix, and a checkmark on whichever one is currently the default.

  Renders the WHOLE hero actions row itself (this button + the two
  "Features"/"View on GitHub" links) rather than just the download button
  alone — see theme/index.ts's own doc comment for why: VPHome.vue doesn't
  forward a slot that lands INSIDE the framework's own `.actions` flex row,
  so recreating that row's exact classes here (`.actions`/`.action`/
  `.VPButton` — copied verbatim from the installed vitepress package's own
  VPHero.vue/VPButton.vue scoped styles) was simpler than fighting that.

  Asset URLs come from a client-side fetch of GitHub's own
  `releases/latest` API (this is a static docs site with no backend of its
  own) — see RELEASE_TARGETS below for the exact filename-matching rules,
  reverse-engineered from a real published release's own asset list
  (release.yml's build matrix), not guessed. A failed/rate-limited fetch
  (GitHub's unauthenticated API is 60 req/hour per IP) degrades every link
  to the plain /releases page — never a broken link, just a less specific one.
-->
<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { withBase } from "vitepress";

const REPO = "zangjiucheng/GitCat";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

// Reverse-engineered from `curl -s https://api.github.com/repos/.../releases/latest`
// against a real published release (v0.8.1) — tauri-action's own naming
// convention per target, which release.yml's build matrix drives, not
// something likely to change without a release.yml edit. Order here is
// also the dropdown's own display order (Apple Silicon leads: it's the
// dominant new-Mac architecture as of this writing, same reasoning
// detectPlatformFamily()'s own mac fallback below uses).
//
// Two labels per target, matching the reference screenshot's own split:
//   mainLabel — the big button copy ("Download beta for macOS (Apple Silicon)")
//   menuLabel — the dropdown row ("Apple Silicon (macOS) · Beta" is
//               menuLabel + the " · Beta" the template appends)
const RELEASE_TARGETS = [
  { id: "mac-arm", mainLabel: "macOS (Apple Silicon)", menuLabel: "Apple Silicon (macOS)", icon: "apple", match: (n) => n.endsWith("_aarch64.dmg") },
  { id: "mac-intel", mainLabel: "macOS (Intel)", menuLabel: "Intel (macOS)", icon: "apple", match: (n) => n.endsWith("_x64.dmg") },
  { id: "win-x64", mainLabel: "Windows AMD64", menuLabel: "Windows AMD64", icon: "windows", match: (n) => n.endsWith("_x64-setup.exe") },
  { id: "win-arm64", mainLabel: "Windows ARM64", menuLabel: "Windows ARM64", icon: "windows", match: (n) => n.endsWith("_arm64-setup.exe") },
  { id: "linux-x64", mainLabel: "Linux 64", menuLabel: "Linux 64", icon: "linux", match: (n) => n.endsWith("_amd64.AppImage") },
  { id: "linux-arm64", mainLabel: "Linux ARM64", menuLabel: "Linux ARM64", icon: "linux", match: (n) => n.endsWith("_aarch64.AppImage") },
];

// Platform icons are the real BRAND marks the reference screenshot uses, not
// the app's generic lucide UI set: a filled Apple logo and a filled
// four-pane Windows logo (both read cleanly as solid silhouettes), plus an
// OUTLINE Tux for Linux — a penguin needs its belly/face drawn, so a solid
// fill would collapse to an unreadable blob (this is exactly why the
// screenshot itself fills Apple/Windows but outlines Linux). `github` (the
// Octocat mark) and `features` (lucide "sparkles") ride along for the two
// secondary hero buttons. All use currentColor so each inherits whatever
// its container's text color is (white on the brand button, muted in the menu).
const ICONS = {
  apple:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 12.536c-.03-3.017 2.47-4.463 2.58-4.535-1.406-2.056-3.594-2.337-4.37-2.368-1.861-.189-3.632 1.096-4.574 1.096-.94 0-2.395-1.069-3.94-1.04-2.026.03-3.896 1.178-4.94 2.994-2.106 3.65-.539 9.056 1.51 12.017 1.002 1.45 2.196 3.078 3.762 3.02 1.51-.06 2.08-.976 3.905-.976 1.826 0 2.34.976 3.937.946 1.625-.03 2.653-1.478 3.646-2.931 1.148-1.681 1.62-3.309 1.648-3.393-.036-.016-3.164-1.214-3.195-4.816zM14.09 3.86c.833-1.01 1.395-2.414 1.242-3.81-1.2.048-2.654.8-3.515 1.81-.77.895-1.446 2.322-1.265 3.694 1.34.104 2.706-.681 3.538-1.694z"/></svg>',
  windows:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.351"/></svg>',
  linux:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6c-2.2 0-3.5 1.8-3.5 4.2 0 1.1.2 1.7-.5 2.7C6.4 11.6 5.4 13.6 5.4 16c0 3.1 2.7 5.4 6.6 5.4s6.6-2.3 6.6-5.4c0-2.4-1-4.4-2.6-6.5-.7-1-.5-1.6-.5-2.7 0-2.4-1.3-4.2-3.5-4.2Z"/><path d="M9.1 13c-.5 1-.8 2.1-.8 3.2 0 1.8 1.6 3 3.7 3s3.7-1.2 3.7-3c0-1.1-.3-2.2-.8-3.2"/><path d="M10.9 8.9h2.2l-1.1 1.5z" fill="currentColor" stroke="none"/><circle cx="10.4" cy="7.5" r=".55" fill="currentColor" stroke="none"/><circle cx="13.6" cy="7.5" r=".55" fill="currentColor" stroke="none"/><path d="M9.4 20.9 8 22.3M14.6 20.9 16 22.3"/></svg>',
  github:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  features:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
};

const CHEVRON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// Module-scope, not component-scope: this component only mounts while the
// home page (`layout: home`) is showing, so a plain component-local ref
// would re-fetch every time a visitor navigates away and back within one
// SPA session. A bare module-level variable survives exactly that, without
// needing sessionStorage/expiry logic for what's already a same-session,
// same-page-load concern only.
let releaseFetch = null;
function fetchLatestRelease() {
  if (!releaseFetch) {
    releaseFetch = fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return releaseFetch;
}

const assetUrls = ref({}); // target id -> browser_download_url, filled in once the fetch above resolves
// `null` until onMounted's client-only detection runs (see its own comment
// below) — the template has to render something sane for this BEFORE
// then too, since Vue hydration requires the client's first render to
// match what VitePress already pre-rendered at build time on Node, where
// there's no navigator/window at all to detect anything from.
const primaryTarget = ref(null);
const dropdownOpen = ref(false);
const rootEl = ref(null);

const primaryMainLabel = computed(
  () => RELEASE_TARGETS.find((t) => t.id === primaryTarget.value)?.mainLabel ?? "your platform"
);
const primaryIcon = computed(() => ICONS[RELEASE_TARGETS.find((t) => t.id === primaryTarget.value)?.icon] ?? "");

function hrefFor(id) {
  return assetUrls.value[id] ?? RELEASES_URL;
}

function toggleDropdown() {
  dropdownOpen.value = !dropdownOpen.value;
}
function closeDropdown() {
  dropdownOpen.value = false;
}
// A dropdown row click both navigates (the <a>'s own href, left alone)
// AND repoints the main button at whatever was just picked — the SAME
// "last explicit choice wins" behavior the reference screenshot's own
// checkmark-follows-selection implies.
function selectTarget(id) {
  primaryTarget.value = id;
  closeDropdown();
}

function onDocClick(e) {
  if (dropdownOpen.value && rootEl.value && !rootEl.value.contains(e.target)) closeDropdown();
}
function onKeydown(e) {
  if (e.key === "Escape" && dropdownOpen.value) closeDropdown();
}

// Best-effort OS family guess from the plain (long-standing, universally
// supported) UA/platform strings — refined below by refineArch() where a
// more precise signal exists. Falls back to the single most common
// architecture per OS when nothing more specific is available: Apple
// Silicon is the dominant new-Mac chip as of this writing, x64 the
// dominant Windows one, x64 the dominant desktop-Linux one.
function detectPlatformFamily() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac-arm";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "win-x64";
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "linux-x64";
  return null;
}

// User-Agent Client Hints (`navigator.userAgentData`) exposes a REAL
// architecture signal that the classic UA string can't reliably give on
// its own — Safari/Firefox don't implement it at all (this silently no-ops
// there, leaving detectPlatformFamily()'s own plain-UA guess as the final
// answer), but Chrome/Edge do, on both mac and Windows.
async function refineArch(family) {
  try {
    const uaData = navigator.userAgentData;
    if (!uaData?.getHighEntropyValues) return family;
    const { architecture } = await uaData.getHighEntropyValues(["architecture"]);
    if (family?.startsWith("mac-")) return architecture === "arm" ? "mac-arm" : "mac-intel";
    if (family?.startsWith("win-")) return architecture === "arm" ? "win-arm64" : "win-x64";
  } catch {
    // getHighEntropyValues can reject (permissions-policy, older Chromium
    // builds with the method present but non-functional) — the plain-UA
    // guess this was trying to refine is still a perfectly good answer.
  }
  return family;
}

onMounted(async () => {
  const family = detectPlatformFamily();
  primaryTarget.value = family;
  refineArch(family).then((refined) => {
    // Only apply the refined guess if the user hasn't ALREADY picked
    // something from the dropdown by the time this resolves — a real
    // click (selectTarget) must never be silently overwritten by a slow
    // async detail arriving after it.
    if (primaryTarget.value === family) primaryTarget.value = refined;
  });

  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);

  const data = await fetchLatestRelease();
  if (data?.assets) {
    const map = {};
    for (const t of RELEASE_TARGETS) {
      const asset = data.assets.find((a) => t.match(a.name));
      if (asset) map[t.id] = asset.browser_download_url;
    }
    assetUrls.value = map;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="actions dl-actions">
    <div class="action">
      <div class="dl-split" :class="{ open: dropdownOpen }" ref="rootEl">
        <a class="dl-main" :href="hrefFor(primaryTarget)">
          <span class="dl-icon" v-html="primaryIcon"></span>
          <span>Download beta for {{ primaryMainLabel }}</span>
        </a>
        <button class="dl-chevron" type="button" aria-label="Other platforms" :aria-expanded="dropdownOpen" @click="toggleDropdown">
          <span class="dl-chevron-icon" :class="{ open: dropdownOpen }" v-html="CHEVRON"></span>
        </button>
        <div v-if="dropdownOpen" class="dl-menu" role="menu">
          <a
            v-for="t in RELEASE_TARGETS"
            :key="t.id"
            class="dl-menu-item"
            role="menuitem"
            :href="hrefFor(t.id)"
            @click="selectTarget(t.id)"
          >
            <span class="dl-menu-check" v-html="t.id === primaryTarget ? CHECK : ''"></span>
            <span class="dl-menu-icon" v-html="ICONS[t.icon]"></span>
            <span class="dl-menu-label">{{ t.menuLabel }} · Beta</span>
          </a>
        </div>
      </div>
    </div>
    <!-- Full-width flex break: forces the two secondary links onto their own
         second row, under the primary download button, instead of trailing
         it on the same line. -->
    <div class="dl-row-break"></div>
    <div class="action">
      <a class="VPButton medium alt dl-linkbtn" :href="withBase('/features')">
        <span class="dl-linkbtn-icon" v-html="ICONS.features"></span>
        <span>Features</span>
      </a>
    </div>
    <div class="action">
      <a class="VPButton medium alt dl-linkbtn" href="https://github.com/zangjiucheng/GitCat" target="_blank" rel="noreferrer">
        <span class="dl-linkbtn-icon" v-html="ICONS.github"></span>
        <span>View on GitHub</span>
      </a>
    </div>
  </div>
</template>
