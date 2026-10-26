// The running-jobs indicator's key action, kept out of bindings.ts the same
// way actions/workdir.ts is: the table row stays one line, and the decision
// lives next to the controller it asks.

import { jobsCtrl } from "@/islands/jobs/jobs.svelte.ts";

export const jobsKeys = {
  /**
   * Mod+Shift+J. Declines (returns false) when nothing is running, so the
   * chord falls through instead of being swallowed by an invisible chip.
   */
  toggle(): false | void {
    return jobsCtrl.toggle() ? undefined : false;
  },
  /**
   * Mod+Shift+J again, from inside the popover's own "modal" scope, where the
   * global row is unreachable. Declines under any other modal.
   */
  close(): false | void {
    if (!jobsCtrl.open) return false;
    jobsCtrl.close();
  },
};
