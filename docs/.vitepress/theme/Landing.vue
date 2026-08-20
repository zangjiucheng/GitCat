<!--
  The homepage's section stack, injected into VPHome's `home-features-after`
  slot (see theme/index.ts). index.md keeps ONLY the hero frontmatter — its
  `features:` grid is deliberately gone, because six equal-weight cards gave
  every capability the same visual weight and buried the one thing that
  actually distinguishes GitCat (Undo) among five things that every Git GUI
  has. These sections are weighted instead: demo, then the safety story, then
  three screenshot blocks, then a compact grid for the long tail.

  Vue SFC rather than raw HTML in index.md so the CSS is scoped (the old
  video block carried ~10 inline `style=` attributes) and so asset URLs go
  through withBase() — markdown src attributes get the `/GitCat/` base
  prepended by VitePress's own transform, but a Vue template's do NOT, so a
  literal "/demo.webm" here would 404 on the deployed project site while
  looking fine under `vitepress dev`.
-->
<script setup>
import { withBase } from "vitepress";

// The three-beat safety story. Each beat borrows the Tama expression the app
// itself shows at that moment, so the site and the product agree.
const BEATS = [
  {
    img: "tama_thinking.webp",
    label: "Before",
    title: "A snapshot is pinned",
    body: "Refs, index, worktree and stash — captured before the command runs, not after it goes wrong.",
  },
  {
    img: "tama_alarm.webp",
    label: "During",
    title: "Tama says the scary part out loud",
    body: "Anything irreversible needs a typed confirmation, and tells you exactly what it will touch.",
  },
  {
    img: "tama_happy.webp",
    label: "After",
    title: "⌘Z puts it back",
    body: "One keystroke, any mutation. Undo is itself a snapshot, so you can undo the undo.",
  },
];

// Alternating screenshot blocks — the three screens that carry the product.
const BLOCKS = [
  {
    shot: "graph.png",
    alt: "GitCat's commit graph, with coloured swimlanes and inline branch labels",
    eyebrow: "Commit graph",
    title: "A graph that keeps up",
    body: "git2 reads and a hand-tuned Rust swimlane layout, streamed onto a virtualized canvas with no depth cap. 150,000 commits scroll smoothly — with the text still readable.",
    points: ["Inline branch and tag chips", "Drag one dot onto another to cherry-pick", "Snap back to HEAD from anywhere"],
  },
  {
    shot: "commit-detail.png",
    alt: "The commit detail panel showing a syntax-highlighted diff",
    eyebrow: "Diffs & staging",
    title: "Down to the line",
    body: "Stage by file, by hunk, or by individual line. Text diffs are syntax-highlighted; images and PDFs get a real before/after preview, rendered natively and zoomable.",
    points: ["Line-level staging", "Side-by-side image & PDF diffs", "Pluggable external diff and merge tools"],
  },
  {
    shot: "command-palette.png",
    alt: "The ⌘K command palette searching commits and refs",
    eyebrow: "Command palette",
    title: "Everything is one keystroke away",
    body: "⌘K fuzzy-searches commits, refs and actions at once — including branches that aren't in the sidebar. Search by author, by full hash, or pickaxe through file content.",
    points: ["Vim-style keys throughout", "Jump straight to Bisect, Reflog, Rerere", "A real native menu, too"],
  },
];

// The long tail: one line each, no icons. Things that matter but don't need
// a screenshot to be understood.
const MORE = [
  { title: "All of real git", body: "Merge, rebase (linear and drag-to-reorder interactive), cherry-pick, revert, bisect, blame with rename-following, submodules, patches, and a git-filter-repo wizard." },
  { title: "Conflicts, resolved", body: "A real 3-way editor with hunk-level resolution, plus rerere and your own external merge tool if you'd rather." },
  { title: "When git can't help", body: "Reflog rescue and dangling-object recovery, for the commits git itself has already given up on." },
  { title: "Plugins", body: "Extend GitCat with ⌘K commands, hooks, side panels, named tools, and Tama skins and reactions." },
  { title: "English, 中文 & 한국어", body: "The whole interface in three languages, switchable live with no reload." },
  { title: "gitcat .", mono: true, body: "Open a repo from your terminal the way <code>code .</code> does — WSL-aware, on every platform." },
];

const TAMA = [
  ["tama_hero.webp", "waving hello"],
  ["tama_curious.webp", "curious"],
  ["tama_thinking.webp", "thinking"],
  ["tama_confident.webp", "confident"],
  ["tama_happy.webp", "celebrating"],
  ["tama_alarm.webp", "alarmed"],
  ["tama_shocked.webp", "shocked"],
  ["tama_sleep.webp", "napping"],
];
</script>

<template>
  <!-- ── Demo ──────────────────────────────────────────────────────────── -->
  <section class="gc-band gc-band--soft gc-demo">
    <div class="gc-wrap">
      <video
        class="gc-video"
        controls
        loop
        playsinline
        preload="metadata"
        :poster="withBase('/demo-poster.jpg')"
        aria-label="A silent demo of GitCat: scrolling the commit graph, inspecting a signed commit, fuzzy-searching with the command palette, and rewinding with a one-keystroke Undo."
      >
        <source :src="withBase('/demo.webm')" type="video/webm" />
        <source :src="withBase('/demo.mp4')" type="video/mp4" />
        <img :src="withBase('/demo-poster.jpg')" alt="GitCat: commit graph, detail panel, and Tama the mascot" />
      </video>
      <p class="gc-caption">
        A real session on CPython — no narration, no edits.
        <a :href="withBase('/guide/screenshots')">Prefer stills? →</a>
      </p>
    </div>
  </section>

  <!-- ── The safety story ──────────────────────────────────────────────── -->
  <section class="gc-band">
    <div class="gc-wrap">
      <p class="gc-eyebrow">The Safety Manager</p>
      <h2 class="gc-h2">Undo is not a feature. It's the point.</h2>
      <p class="gc-lede">
        Every Git GUI makes it easy to run a dangerous command. GitCat is built so you can take it back —
        every mutation, all the way down, including the ones git itself considers final.
      </p>
      <div class="gc-beats">
        <div v-for="b in BEATS" :key="b.label" class="gc-beat">
          <img :src="withBase(`/tama/${b.img}`)" :alt="`Tama, ${b.label.toLowerCase()}`" loading="lazy" />
          <p class="gc-beat-label">{{ b.label }}</p>
          <h3>{{ b.title }}</h3>
          <p>{{ b.body }}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Screenshot blocks ─────────────────────────────────────────────── -->
  <section class="gc-band gc-band--soft">
    <div class="gc-wrap">
      <article v-for="(b, i) in BLOCKS" :key="b.shot" class="gc-block" :class="{ 'gc-block--flip': i % 2 === 1 }">
        <div class="gc-block-text">
          <p class="gc-eyebrow">{{ b.eyebrow }}</p>
          <h3 class="gc-h3">{{ b.title }}</h3>
          <p>{{ b.body }}</p>
          <ul>
            <li v-for="p in b.points" :key="p">{{ p }}</li>
          </ul>
        </div>
        <a class="gc-shot" :href="withBase('/guide/screenshots')">
          <img :src="withBase(`/screenshots/${b.shot}`)" :alt="b.alt" loading="lazy" />
        </a>
      </article>
    </div>
  </section>

  <!-- ── The long tail ─────────────────────────────────────────────────── -->
  <section class="gc-band">
    <div class="gc-wrap">
      <p class="gc-eyebrow">And the rest of it</p>
      <h2 class="gc-h2">The deep cuts, too</h2>
      <div class="gc-grid">
        <div v-for="m in MORE" :key="m.title" class="gc-cell">
          <h3 :class="{ 'gc-mono': m.mono }">{{ m.title }}</h3>
          <p v-html="m.body"></p>
        </div>
      </div>
      <p class="gc-more"><a :href="withBase('/features')">The exhaustive feature list →</a></p>
    </div>
  </section>

  <!-- ── Tama ──────────────────────────────────────────────────────────── -->
  <section class="gc-band gc-band--soft">
    <div class="gc-wrap gc-tama-strip">
      <img
        v-for="[file, mood] in TAMA"
        :key="file"
        :src="withBase(`/tama/${file}`)"
        :alt="`Tama ${mood}`"
        loading="lazy"
      />
    </div>
    <div class="gc-wrap gc-wrap--narrow">
      <p class="gc-eyebrow">Meet Tama</p>
      <h2 class="gc-h2">Not a mascot. The one holding the snapshot.</h2>
      <p class="gc-lede">
        Eight expressions, wired to real moments: curious while you search, thinking hard mid-rebase,
        genuinely alarmed right before something irreversible — and celebrating once it's safely done.
      </p>
      <p class="gc-more"><a :href="withBase('/guide/tama')">More about Tama →</a></p>
    </div>
  </section>

  <!-- ── CTA ───────────────────────────────────────────────────────────── -->
  <section class="gc-band gc-cta">
    <div class="gc-wrap gc-wrap--narrow">
      <h2 class="gc-h2">Point it at a repo you care about.</h2>
      <p class="gc-lede">That's rather the whole idea — nothing it does to your history can't be taken back.</p>
      <div class="gc-cta-row">
        <a class="gc-btn gc-btn--brand" :href="withBase('/install')">Download GitCat</a>
        <a class="gc-btn" href="https://github.com/zangjiucheng/GitCat">View source</a>
      </div>
      <p class="gc-fine">Free and open source under the GPLv3 · macOS, Windows and Linux · no account, no cloud</p>
    </div>
  </section>
</template>

<style scoped>
/* Bands are full-bleed (VPHome puts no container around its slots) with their
   own inner max-width, matching VPFeatures' own 1152px so the hero above and
   these sections share one measure. */
.gc-band {
  padding: 72px 24px;
}
.gc-band--soft {
  background: var(--vp-c-bg-alt);
  border-block: 1px solid var(--vp-c-divider);
}
.gc-wrap {
  max-width: 1152px;
  margin: 0 auto;
}
.gc-wrap--narrow {
  max-width: 720px;
  text-align: center;
}

/* ---- Shared type scale. The rounded display face on headings only, same
   split custom.css already uses: personality on headings, Inter for prose. */
.gc-eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--vp-c-teal-1);
  margin: 0 0 10px;
}
.gc-h2 {
  font-family: var(--gc-display);
  font-size: clamp(28px, 4vw, 38px);
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
  margin: 0 0 14px;
  color: var(--vp-c-text-1);
}
.gc-h3 {
  font-family: var(--gc-display);
  font-size: clamp(22px, 3vw, 27px);
  line-height: 1.25;
  letter-spacing: -0.01em;
  font-weight: 700;
  margin: 0 0 12px;
  color: var(--vp-c-text-1);
}
.gc-lede {
  font-size: 17px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0;
  max-width: 62ch;
}
.gc-wrap--narrow .gc-lede {
  margin-inline: auto;
}
.gc-more {
  margin: 28px 0 0;
  font-weight: 500;
}
.gc-more a,
.gc-caption a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}
.gc-more a:hover,
.gc-caption a:hover {
  text-decoration: underline;
}

/* ---- Demo ---- */
.gc-demo {
  padding-top: 8px;
}
.gc-video {
  display: block;
  width: 100%;
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 18px 50px rgb(0 0 0 / 22%);
  cursor: pointer;
  background: #000;
}
.gc-caption {
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 14px;
  margin: 14px 0 0;
}

/* ---- Three-beat safety story ---- */
.gc-beats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 28px;
  margin-top: 44px;
}
.gc-beat {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 24px;
  transition:
    border-color 0.25s,
    transform 0.25s;
}
.gc-beat:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-3px);
}
.gc-beat img {
  width: 78px;
  height: auto;
  margin-bottom: 12px;
}
.gc-beat-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin: 0 0 6px;
}
.gc-beat h3 {
  font-family: var(--gc-display);
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--vp-c-text-1);
}
.gc-beat p:last-child {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

/* ---- Alternating screenshot blocks ---- */
.gc-block {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 48px;
  align-items: center;
}
.gc-block + .gc-block {
  margin-top: 88px;
}
.gc-block--flip .gc-block-text {
  order: 2;
}
.gc-block-text > p {
  font-size: 16px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  margin: 0;
}
.gc-block-text ul {
  list-style: none;
  padding: 0;
  margin: 18px 0 0;
}
.gc-block-text li {
  position: relative;
  padding-left: 22px;
  margin-bottom: 8px;
  font-size: 14.5px;
  color: var(--vp-c-text-2);
}
/* A teal check instead of a bullet — same "color reserved for meaning" rule
   the app follows; these are capabilities, not a list of nouns. */
.gc-block-text li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 6px;
  width: 12px;
  height: 7px;
  border-left: 2px solid var(--vp-c-teal-1);
  border-bottom: 2px solid var(--vp-c-teal-1);
  transform: rotate(-45deg);
}
.gc-shot {
  display: block;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 14px 40px rgb(0 0 0 / 16%);
  transition:
    transform 0.3s,
    box-shadow 0.3s;
}
.gc-shot:hover {
  transform: translateY(-4px);
  box-shadow: 0 20px 52px rgb(0 0 0 / 24%);
}
.gc-shot img {
  display: block;
  width: 100%;
  height: auto;
}

/* ---- Long-tail grid ---- */
.gc-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 26px 40px;
  margin-top: 40px;
}
.gc-cell h3 {
  font-family: var(--gc-display);
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 7px;
  color: var(--vp-c-text-1);
}
.gc-cell h3.gc-mono {
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
}
.gc-cell p {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
/* :deep — the <code> comes from v-html, so it carries no scope attribute. */
.gc-cell p :deep(code) {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  background: var(--vp-c-bg-soft);
  border-radius: 4px;
  padding: 1px 5px;
}

/* ---- Tama strip ---- */
/* Widths are computed from the row, not fixed, so the eight portraits stay on
   ONE line at every width instead of orphaning the eighth onto a second row —
   which is exactly what a fixed 92px did inside the narrow 720px copy column. */
.gc-tama-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-bottom: 28px;
}
.gc-tama-strip img {
  width: calc((100% - 7 * 8px) / 8);
  max-width: 104px;
  height: auto;
  transition:
    transform 0.25s,
    filter 0.25s;
}
/* Only the hovered one comes forward — the strip reads as a cast, and picking
   one out of it is the whole interaction. */
.gc-tama-strip:hover img {
  filter: grayscale(0.55) opacity(0.55);
}
.gc-tama-strip img:hover {
  filter: none;
  transform: translateY(-6px) scale(1.08);
}

/* ---- CTA ---- */
.gc-cta {
  padding-bottom: 8px;
}
.gc-cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-top: 28px;
}
.gc-btn {
  display: inline-block;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  padding: 0 22px;
  line-height: 40px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition:
    background-color 0.25s,
    border-color 0.25s,
    transform 0.25s;
}
.gc-btn:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}
.gc-btn--brand {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-white, #fff);
}
.gc-btn--brand:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}
.dark .gc-btn--brand {
  color: #16181d;
}
.gc-fine {
  margin: 20px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

/* ---- Responsive ---- */
@media (max-width: 960px) {
  .gc-beats,
  .gc-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .gc-block {
    grid-template-columns: 1fr;
    gap: 28px;
  }
  /* Text always leads on narrow screens; the flip only makes sense side-by-side. */
  .gc-block--flip .gc-block-text {
    order: 0;
  }
  .gc-block + .gc-block {
    margin-top: 64px;
  }
}
@media (max-width: 640px) {
  .gc-band {
    padding: 52px 20px;
  }
  .gc-beats,
  .gc-grid {
    grid-template-columns: 1fr;
  }
  /* Two rows of four rather than eight unreadable thumbnails. */
  .gc-tama-strip img {
    width: calc((100% - 3 * 8px) / 4);
  }
}

/* Honour the OS setting — every transform/transition above is decorative. */
@media (prefers-reduced-motion: reduce) {
  .gc-beat,
  .gc-shot,
  .gc-btn,
  .gc-tama-strip img {
    transition: none;
  }
  .gc-beat:hover,
  .gc-shot:hover,
  .gc-btn:hover,
  .gc-tama-strip img:hover {
    transform: none;
  }
}
</style>
