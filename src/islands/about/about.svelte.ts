// About panel — controller (Svelte 5 runes singleton).
//
// Replaces the native OS "About" menu item (see src-tauri/src/menu.rs's
// header comment for why) with a small in-app modal that can actually be
// animated. get_app_info() is pure static build metadata — safe to call
// with no repo open, never errors in the real app. In browser design-mode
// (no Tauri backend) the invoke naturally rejects, so show() falls back to
// canned info instead of needing a separate openDemo() entry point — this
// panel has no real/demo BEHAVIORAL difference, just a data source.

import { commands } from "../../ipc/bindings";
import type { AppInfo } from "../../ipc/bindings";

const DEMO_INFO: AppInfo = {
  name: "GitCat",
  version: "0.0.0-dev",
  description: "A git GUI client with a Safety Manager that never lets you lose history.",
  authors: ["Jiucheng Zang"],
  copyright: "\u{a9} Jiucheng Zang",
  website: "https://github.com/zangjiucheng/GitCat",
};

function openExternal(url: string) {
  const w = window as unknown as { __TAURI__?: any };
  if (w.__TAURI__?.opener?.openUrl) {
    w.__TAURI__.opener.openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

class AboutState {
  open = $state(false);
  loading = $state(false);
  info = $state<AppInfo | null>(null);

  async show() {
    this.open = true;
    if (this.info) return; // cached from a previous open — static data, never changes
    this.loading = true;
    try {
      this.info = await commands.getAppInfo();
    } catch {
      this.info = DEMO_INFO; // no Tauri backend (browser design-mode) — still previewable
    } finally {
      this.loading = false;
    }
  }

  close() {
    this.open = false;
  }

  openWebsite() {
    if (this.info?.website) openExternal(this.info.website);
  }
}

export const aboutCtrl = new AboutState();
