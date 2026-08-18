import { defineConfig } from "vitepress";

// Absolute site origin (project site — the /GitCat/ base is part of it). Social
// crawlers ignore relative og:image/url, so these MUST be absolute.
const SITE = "https://zangjiucheng.github.io/GitCat";
// A purpose-built 1200×630 card (docs/public/social-card.png), NOT the full app
// screenshot — the screenshot is unreadable at share-thumbnail size.
const OG_IMAGE = `${SITE}/social-card.png`;
const DESCRIPTION =
  "A cozy, safety-first desktop Git client: a fast commit graph, line-level staging, drag-and-drop cherry-pick and merge, rebase, bisect, and a Safety Manager that snapshots before every mutation so Undo is always one keystroke away.";
// GA4 (chosen over Plausible because a measurement ID isolates GitCat despite the
// shared zangjiucheng.github.io domain). The measurement id is NOT a secret — it's
// exposed in the served page source regardless — so it's hardcoded here, with a
// GA_MEASUREMENT_ID build-env override for a staging/fork property. Outbound-
// installer-click + UTM tracking come free from GA4 Enhanced Measurement (on by
// default in the property); no extra page code needed.
const GA_ID = process.env.GA_MEASUREMENT_ID?.trim() || "G-W6VT14DVP0";

// Served from https://zangjiucheng.github.io/GitCat/ (a project site, not a
// user/org site) — `base` must match the repo name exactly or every asset
// and internal link 404s once deployed, even though everything looks fine
// under `vitepress dev` (which ignores `base`).
export default defineConfig({
  base: "/GitCat/",
  title: "GitCat",
  description: "A cozy, safety-first desktop Git client.",
  lastUpdated: true,
  cleanUrls: true,

  // Static, every-page tags. Per-page og:/twitter:/canonical (which need the
  // page's own title/url) are added in transformHead below.
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/GitCat/gitcat-icon.svg" }],
    ["meta", { name: "theme-color", content: "#C88A3E" }],
    ["meta", { property: "og:site_name", content: "GitCat" }],
    ...(GA_ID
      ? ([
          ["script", { async: "", src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}` }],
          ["script", {}, `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');`],
        ] as const)
      : []),
  ],

  // Per-page social metadata with ABSOLUTE urls (crawlers ignore relative ones):
  // canonical + Open Graph + Twitter card. Title/description/url are derived from
  // each page so a shared FAQ/Features link previews as itself, not the homepage.
  transformHead({ pageData }) {
    const isHome = pageData.relativePath === "index.md";
    const clean = pageData.relativePath
      .replace(/(^|\/)index\.md$/, "$1")
      .replace(/\.md$/, "")
      .replace(/\/$/, "");
    const url = clean ? `${SITE}/${clean}` : SITE;
    const title = isHome ? "GitCat — A cozy, safety-first desktop Git client" : `${pageData.title} | GitCat`;
    const description = isHome ? DESCRIPTION : pageData.description || DESCRIPTION;
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:image", content: OG_IMAGE }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
      ["meta", { name: "twitter:image", content: OG_IMAGE }],
    ];
  },

  themeConfig: {
    logo: "/gitcat-icon.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/" },
      { text: "Screenshots", link: "/guide/screenshots" },
      { text: "Install", link: "/install" },
      { text: "Features", link: "/features" },
      { text: "Plugins", link: "/plugins" },
      { text: "FAQ", link: "/faq" },
    ],

    // A sidebar only for the /guide/ user manual (the other pages stay
    // sidebar-less, full-width marketing/reference pages). Grouped to match the
    // manual's four arcs: get oriented, do everyday work, stay safe, go deeper.
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Overview & layout", link: "/guide/" },
            { text: "Screenshots", link: "/guide/screenshots" },
            { text: "Opening a repository", link: "/guide/opening-a-repository" },
            { text: "Reading the commit graph", link: "/guide/commit-graph" },
          ],
        },
        {
          text: "Everyday work",
          items: [
            { text: "Committing & staging", link: "/guide/committing" },
            { text: "Branches & tags", link: "/guide/branches" },
            { text: "Syncing with remotes", link: "/guide/remotes" },
            { text: "Cherry-pick, merge & revert", link: "/guide/combining" },
            { text: "Rebasing", link: "/guide/rebasing" },
          ],
        },
        {
          text: "Safety & recovery",
          items: [
            { text: "Undo & the Safety Manager", link: "/guide/undo-safety" },
            { text: "History & recovery tools", link: "/guide/history-tools" },
            { text: "Rewriting history", link: "/guide/rewriting-history" },
          ],
        },
        {
          text: "Power & customization",
          items: [
            { text: "Command palette & keyboard", link: "/guide/keyboard" },
            { text: "Terminal & external tools", link: "/guide/terminal-tools" },
            { text: "Tama", link: "/guide/tama" },
            { text: "Plugins", link: "/guide/plugins" },
            { text: "Settings", link: "/guide/settings" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/zangjiucheng/GitCat" }],

    // detailedView: default VitePress local search hides the matched excerpt
    // behind a toggle button, so results show only a section heading with no
    // clue why it matched or what's actually there — with only 4 short pages
    // (docs/*.md) to search, that heading-only view is nearly useless. Always
    // showing the highlighted excerpt is the one-line fix.
    search: { provider: "local", options: { detailedView: true } },

    footer: {
      message: "Released under the GNU General Public License v3.0 or later.",
      copyright: "Copyright © 2026 Jiucheng Zang",
    },

    editLink: {
      pattern: "https://github.com/zangjiucheng/GitCat/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
