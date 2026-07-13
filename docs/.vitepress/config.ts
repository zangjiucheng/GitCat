import { defineConfig } from "vitepress";

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

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/GitCat/gitcat-icon.svg" }],
    ["meta", { name: "theme-color", content: "#C88A3E" }],
    ["meta", { property: "og:image", content: "/GitCat/screenshot.png" }],
  ],

  themeConfig: {
    logo: "/gitcat-icon.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "Install", link: "/install" },
      { text: "Features", link: "/features" },
      { text: "FAQ", link: "/faq" },
    ],

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
