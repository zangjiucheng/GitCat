// The way out of the shell (#142).
import { beforeEach, describe, expect, it } from "vitest";

import { terminalFocusOut } from "./terminal.ts";

describe("terminalFocusOut", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("moves focus to the graph pane", () => {
    document.body.innerHTML = `
      <div data-pane="graph"><canvas id="cv" tabindex="0"></canvas></div>
      <div class="term-drawer"><textarea id="shell"></textarea></div>`;
    const shell = document.getElementById("shell") as HTMLTextAreaElement;
    shell.focus();
    expect(document.activeElement).toBe(shell);

    expect(terminalFocusOut()).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("cv"));
  });

  it("declines rather than swallowing the key when there is no graph to land on", () => {
    // A live binding that returns false lets the walk continue (see
    // dispatch.test.ts's "a live binding with no run() still claims the key"
    // for the converse). Landing nowhere and still claiming Shift+Escape would
    // leave the user exactly as stuck as before the binding existed.
    document.body.innerHTML = `<div class="term-drawer"><textarea id="shell"></textarea></div>`;
    expect(terminalFocusOut()).toBe(false);
  });

  it("leaves the terminal drawer open", () => {
    // "Get me out of the shell" and "close the shell" are different
    // intentions; the second already has a key and a button.
    document.body.innerHTML = `
      <div data-pane="graph"><canvas id="cv" tabindex="0"></canvas></div>
      <div class="term-drawer on"><textarea id="shell"></textarea></div>`;
    terminalFocusOut();
    expect(document.querySelector(".term-drawer")?.classList.contains("on")).toBe(true);
  });
});
