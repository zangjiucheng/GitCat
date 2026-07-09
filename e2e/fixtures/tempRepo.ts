// Disposable git repository for E2E tests — the TS mirror of
// src-tauri/tests/common/mod.rs's `TempRepo`. Same rationale: a real `git`
// binary shelled out to (not a JS git reimplementation), so fixtures behave
// exactly like a repo a user would actually have on disk, and the Playwright
// mock backend (see tauriMock.ts) can read them with plain git plumbing.
//
// CRITICAL SAFETY: every repo lives under `os.tmpdir()` with a name unique
// per process+time, and `commit.gpgsign`/`tag.gpgsign` are forced off right
// after `git init` — without that, a commit would hang forever on a GPG
// passphrase prompt and hang the whole test run. NEVER point this at a real
// repo. Cleanup is try/finally-driven (see the `withTempRepo` helper) so a
// failed assertion still removes the directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export class TempRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static init(tag: string): TempRepo {
    const dir = mkdtempSync(join(tmpdir(), `gitcat-e2e-${tag}-`));
    const repo = new TempRepo(dir);
    repo.git("init", "-q", "-b", "main");
    // Same two CRITICAL lines as the Rust TempRepo — see file header.
    repo.git("config", "commit.gpgsign", "false");
    repo.git("config", "tag.gpgsign", "false");
    // Repo-local identity so commits never depend on the host's global
    // git config (a bare CI runner may not have one at all).
    repo.git("config", "user.name", "GitCat E2E");
    repo.git("config", "user.email", "e2e@gitcat.test");
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
  }

  /** Write (creating parent dirs as needed) and `git add` a file, relative to the repo root. */
  writeFile(relPath: string, contents: string): void {
    const abs = join(this.dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    this.git("add", "--", relPath);
  }

  commit(message: string, opts: { allowEmpty?: boolean } = {}): string {
    const args = ["commit", "-q", "-m", message];
    if (opts.allowEmpty) args.push("--allow-empty");
    this.git(...args);
    return this.git("rev-parse", "HEAD");
  }

  branch(name: string, startPoint = "HEAD"): void {
    this.git("branch", name, startPoint);
  }

  checkout(name: string): void {
    this.git("checkout", "-q", name);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Build a repo with a small, realistic commit history: 3 commits on main plus a feature branch. */
export function seedBasicRepo(tag: string): TempRepo {
  const repo = TempRepo.init(tag);
  repo.writeFile("README.md", "# GitCat E2E fixture\n");
  repo.commit("Initial commit");
  repo.writeFile("src/lib.ts", "export const answer = 42;\n");
  repo.commit("Add lib.ts");
  repo.branch("feature/widget");
  repo.writeFile("docs/notes.md", "notes\n");
  repo.commit("Add docs");
  return repo;
}
