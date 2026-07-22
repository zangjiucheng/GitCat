<!--
  Replaces index.md's old plain "Download" hero button (a static link to
  the bare /releases page) with an OS-auto-detecting split button, styled
  after the reference screenshot the request was built from: one big
  "Download for <platform>" button plus a chevron opening a dropdown of
  every other build, each with its own small platform icon and a checkmark
  on whichever one is currently the default.

  Renders the WHOLE hero actions row itself (this button + the two plain
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
const RELEASE_TARGETS = [
  { id: "mac-arm", label: "Apple Silicon (macOS)", icon: "apple", match: (n) => n.endsWith("_aarch64.dmg") },
  { id: "mac-intel", label: "Intel (macOS)", icon: "apple", match: (n) => n.endsWith("_x64.dmg") },
  { id: "win-x64", label: "Windows x64", icon: "windows", match: (n) => n.endsWith("_x64-setup.exe") },
  { id: "win-arm64", label: "Windows ARM64", icon: "windows", match: (n) => n.endsWith("_arm64-setup.exe") },
  { id: "linux-x64", label: "Linux x64", icon: "linux", match: (n) => n.endsWith("_amd64.AppImage") },
  { id: "linux-arm64", label: "Linux ARM64", icon: "linux", match: (n) => n.endsWith("_aarch64.AppImage") },
];

// Stroke-based, currentColor — the SAME lucide icon language custom.css
// already established for the feature-card icons just above this
// component on the page (see index.md's own doc comment on why: matches
// the app's own @lucide/svelte icon set rather than emoji/platform glyphs).
// windows/linux aren't real lucide icons (lucide is a generic UI icon set,
// not a brand-mark one) — hand-drawn here in the same stroke style so all
// three read as one consistent family instead of a mismatched grab-bag.
const ICONS = {
  apple: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.528V3a1 1 0 0 1 1-1h0"/><path d="M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21"/></svg>',
  windows:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  linux:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="8" rx="3.4" ry="3.8"/><path d="M7.7 11.2c-1 1.8-1.5 3.5-1.5 5.3 0 3 2.4 4.8 5.8 4.8s5.8-1.8 5.8-4.8c0-1.8-.5-3.5-1.5-5.3"/><circle cx="10.3" cy="7.6" r=".55" fill="currentColor" stroke="none"/><circle cx="13.7" cy="7.6" r=".55" fill="currentColor" stroke="none"/></svg>',
};

const CHEVRON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// SHORT label for the main button (`Download for ${shortLabel}`) — the
// dropdown row uses the fuller `label` above instead ("Apple Silicon
// (macOS)"), matching the reference screenshot's own split between a
// terse main button and more descriptive menu rows.
const SHORT_LABEL = {
  "mac-arm": "macOS",
  "mac-intel": "macOS (Intel)",
  "win-x64": "Windows",
  "win-arm64": "Windows (ARM64)",
  "linux-x64": "Linux",
  "linux-arm64": "Linux (ARM64)",
};

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

const primaryShortLabel = computed(() => SHORT_LABEL[primaryTarget.value] ?? "your platform");
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
          <span>Download for {{ primaryShortLabel }}</span>
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
            <span class="dl-menu-label">{{ t.label }}</span>
          </a>
        </div>
      </div>
    </div>
    <div class="action">
      <a class="VPButton medium alt" :href="withBase('/features')">Features</a>
    </div>
    <div class="action">
      <a class="VPButton medium alt" href="https://github.com/zangjiucheng/GitCat" target="_blank" rel="noreferrer">View on GitHub</a>
    </div>
  </div>
</template>
