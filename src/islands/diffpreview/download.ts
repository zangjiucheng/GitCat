// "Download this before/after version" for an image/PDF diff side (issue #37).
// Mirrors the format-patch export flow: pick a destination with the native
// `save()` dialog, then let the backend write the raw blob bytes there.
import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "@/ipc/bindings";
import { t, be } from "@/i18n/i18n.svelte.ts";
import * as bridge from "@/legacy/bridge";

/**
 * Save the `rev` side of `file` to a user-chosen path. `which` ("before" /
 * "after") only shapes the suggested filename. Reports via the Tama toast.
 */
export async function downloadSide(
  repo: string,
  rev: string,
  file: string,
  which: "before" | "after",
): Promise<void> {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const suggested = ext ? `${stem}-${which}.${ext}` : `${base}-${which}`;

  let dest: string | null;
  try {
    dest = await save({
      defaultPath: suggested,
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
    });
  } catch (e) {
    bridge.tama.warn(String(e));
    return;
  }
  if (!dest) return; // user cancelled the dialog

  const r = await commands.exportBlob(repo, rev, file, dest);
  if (r.status === "ok") {
    bridge.tama.set("celebrate");
    bridge.tama.say(t("preview.downloaded"));
  } else {
    bridge.tama.warn(be(r.error));
  }
}
