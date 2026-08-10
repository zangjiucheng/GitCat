// Reset HEAD to a commit — controller (Svelte 5 runes singleton).
//
// A NEW entry point onto git's `reset`, fronting git_write.rs's
// `reset_head_to_commit(path, target, mode)`. Two ways in, both landing on the
// SAME shared danger scrim (`bridge.armDanger`) that force-push/delete-branch/
// remove-submodule already use — this is the app's canonical "type to arm,
// then confirm" gate, and reset is exactly that kind of deliberately-armed
// destructive move:
//   • resetToKnownCommit() — the commit-row right-click menu's "Reset HEAD to
//     here…" (target sha already known; the type-to-arm string is its short
//     sha, so you literally re-type the commit you're moving onto).
//   • promptForHash()      — the ⌘K / Tools "Reset HEAD to commit…" action:
//     no target yet, so the scrim carries a hash/ref input you fill in; the
//     backend resolves it (a full/short sha, `HEAD~2`, `origin/main`, …) and
//     fails cleanly on anything it can't peel to a commit.
//
// The mode (soft/mixed/hard) is picked IN the scrim each time via an injected
// radio group (mixed is git's own default and is pre-selected). Reading the
// choice back out of the DOM in onConfirm (rather than threading it through
// component state) mirrors how the scrim already treats its own #confirmInput —
// only one danger scrim is ever open at a time, so a name/id query is safe.
//
// SAFETY: the backend snapshots the current HEAD FIRST, so ⌘Z/Undo can walk
// HEAD back to where it was — BUT that snapshot pins committed history only,
// not the working tree, so a `hard` reset's discarded uncommitted changes have
// no recovery path (same limit as Undo/reflog-restore). That asymmetry is
// exactly what the note + the hard-mode copy below spell out before arming.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { ICON_BACKUP, ICON_WARNING } from "../../legacy/icons";
import { t, be } from "@/i18n/i18n.svelte.ts";

type ResetMode = "soft" | "mixed" | "hard";

// Stable ids/names for the controls injected into the (single, shared) danger
// scrim, read back in onConfirm. Namespaced so they can't collide with any
// other scrim content.
const MODE_NAME = "gcResetMode";
const HASH_ID = "gcResetHash";

const RADIO_LABEL_STYLE =
  "display:flex;gap:8px;align-items:flex-start;margin:6px 0;line-height:1.45;cursor:pointer";
const RADIO_STYLE = "margin-top:3px;flex:none";
const HASH_INPUT_STYLE =
  "width:100%;box-sizing:border-box;padding:7px 10px;margin:4px 0 2px;border-radius:8px;" +
  "border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.08);color:inherit;font:inherit";

// The mode picker — trusted markup (no user input interpolated), injected as
// innerHTML into the scrim's "what happens" box. `mixed` pre-checked. Built as
// a function (not a module const) so t() resolves at open time, re-picking the
// active locale on every arm. The translated label already carries its own
// <b>…</b>, so it drops straight into the <span>.
function modeRadios(): string {
  return (
    "<h5>" + t("resethead.reset_mode_head") + "</h5>" +
    `<label style="${RADIO_LABEL_STYLE}"><input type="radio" name="${MODE_NAME}" value="soft" style="${RADIO_STYLE}"><span>${t("resethead.mode_soft")}</span></label>` +
    `<label style="${RADIO_LABEL_STYLE}"><input type="radio" name="${MODE_NAME}" value="mixed" checked style="${RADIO_STYLE}"><span>${t("resethead.mode_mixed")}</span></label>` +
    `<label style="${RADIO_LABEL_STYLE}"><input type="radio" name="${MODE_NAME}" value="hard" style="${RADIO_STYLE}"><span>${t("resethead.mode_hard")}</span></label>`
  );
}

function resetNote(): string {
  return ICON_BACKUP + " " + t("resethead.note_snapshot") + " " + ICON_WARNING + " " + t("resethead.note_hard");
}

function selectedMode(): ResetMode {
  const el = document.querySelector(`input[name="${MODE_NAME}"]:checked`) as HTMLInputElement | null;
  const v = el?.value;
  return v === "soft" || v === "hard" ? v : "mixed";
}

function typedHash(): string {
  const el = document.getElementById(HASH_ID) as HTMLInputElement | null;
  return (el?.value || "").trim();
}

class ResetHeadState {
  // Re-entrancy guard for the real (IN_TAURI) reset round-trip — mirrors
  // forcePushCtrl.busy. The armDanger scrim disables its own confirm button
  // while onConfirm is in flight; this additionally refuses a second arm from
  // a different entry point (⌘K while a menu-triggered reset is still running).
  busy = $state(false);

  // Commit-row menu → "Reset HEAD to here…". Target is the right-clicked
  // commit, so the type-to-arm string is its short sha.
  resetToKnownCommit(repo: string, sha: string, shortSha: string, subject: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn(t("resethead.open_repo_first"));
      return;
    }
    bridge.tama.set("danger");
    bridge.tama.say(t("resethead.arm_say_known", { sha: shortSha }), 6000);
    bridge.armDanger({
      title: t("resethead.title_known", { sha: shortSha }),
      steps: false,
      desc: t("resethead.desc_known", { sha: shortSha, subject: subject ? " — “" + subject + "”" : "" }),
      lose: modeRadios(),
      note: resetNote(),
      name: shortSha,
      typeNoun: "short SHA",
      typeVerb: "confirm the reset",
      confirmLabel: t("resethead.confirm"),
      onConfirm: async () => {
        await this.doReset(repo, sha, selectedMode(), shortSha);
      },
    });
  }

  // ⌘K / Tools → "Reset HEAD to commit…". No target yet: the scrim carries a
  // hash/ref input the backend resolves. Type-to-arm string is the literal
  // word "reset" (there's no known sha to echo here).
  promptForHash(repo: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn(t("resethead.open_repo_first"));
      return;
    }
    bridge.tama.set("danger");
    bridge.tama.say(t("resethead.arm_say_hash"), 6000);
    bridge.armDanger({
      title: t("resethead.title_hash"),
      steps: false,
      desc: t("resethead.desc_hash"),
      lose:
        "<h5>" + t("resethead.commit_to_reset") + "</h5>" +
        `<input id="${HASH_ID}" placeholder="${t("resethead.hash_placeholder")}" spellcheck="false" autocomplete="off" style="${HASH_INPUT_STYLE}"/>` +
        modeRadios(),
      note: resetNote(),
      name: "reset",
      typeNoun: "word",
      typeVerb: "confirm",
      confirmLabel: t("resethead.confirm"),
      onConfirm: async () => {
        const target = typedHash();
        if (!target) {
          bridge.tama.warn(t("resethead.enter_hash"));
          return;
        }
        // Short, readable label for the toasts; the backend echoes the real
        // resolved short sha in its own success message regardless.
        const label = target.length > 12 ? target.slice(0, 10) + "…" : target;
        await this.doReset(repo, target, selectedMode(), label);
      },
    });
  }

  // The actual mutation, shared by both entry points. `label` is only for the
  // in-flight/failure toasts; the backend's success message names the resolved
  // short sha + snapshot, so that's preferred when present.
  private async doReset(repo: string, target: string, mode: ResetMode, label: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say(t("resethead.demo_reset", { label, mode }));
      return;
    }
    if (this.busy) return;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say(t("resethead.resetting", { label }));
    try {
      const res = await commands.resetHeadToCommit(repo, target, mode);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(be(res.message) || t("resethead.reset_done", { label }), 3200);
      } else {
        bridge.tama.warn(be(res && res.message) || t("resethead.reset_failed", { label }));
      }
    } catch (e) {
      bridge.tama.warn(t("resethead.reset_failed_e", { error: String(e) }));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const resetHeadCtrl = new ResetHeadState();
