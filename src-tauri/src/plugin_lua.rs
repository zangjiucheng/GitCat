//! Embedded Luau plugin runtime (PER-56) — the security-critical core.
//!
//! A GitCat plugin MAY ship one main `.lua` file (path in `Plugin.lua`,
//! relative to the plugin dir) that `return`s a table of NAMED handler
//! functions; a command/hook names one via its `handler` field. This module
//! runs that handler inside a LOCKED-DOWN Luau VM whose ONLY window to the
//! outside world is a small, curated host API we inject by hand.
//!
//! ## The sandbox recipe (proven by the probe below)
//!
//! `Lua::new_with(STRING | MATH | TABLE, LuaOptions::default())` loads ONLY a
//! safe stdlib subset — NOT `os`/`io`/`package`/`debug`. `lua.sandbox(true)`
//! then enables Luau's sandbox mode: it freezes the shared globals read-only and
//! swaps in a fresh per-thread global table (with the frozen base as a read-only
//! `__index` fallback), so a script can create its own globals/locals but can
//! never mutate ours or reach a library we withheld. See [`probe`] for the
//! exhaustively-checked minimal version of this.
//!
//! ## THE sandbox caveat this runtime had to close (found empirically)
//!
//! `new_with(STRING|MATH|TABLE)` + `sandbox(true)` is NOT sufficient on its own:
//! Luau's ALWAYS-ON base library still leaves several capability-bearing globals
//! reachable, and the most dangerous is **`require`** — mlua's Luau `require` is
//! a REAL filesystem module loader (`require('./x')`, `require('../x')`,
//! `require('@alias/x')` navigate the actual disk and load/execute `.luau`
//! files), i.e. a sandbox ESCAPE that survives `sandbox(true)`. Also left
//! reachable: `loadstring` (runtime source compilation), `getfenv`/`setfenv`
//! (environment manipulation), and `newproxy`. So BEFORE calling `sandbox(true)`
//! we DELETE these from the (still-writable) globals table (see
//! [`STRIPPED_GLOBALS`] / [`strip_dangerous_globals`]); the freeze then locks in
//! a base that lacks them, and the per-thread `__index` fallback finds nothing,
//! so each is `nil` to the script. This MUST happen before the freeze — a
//! sandboxed global table is read-only, and a plain `set(name, nil)` afterwards
//! would not shadow the `__index` parent anyway (a nil entry reads as "absent",
//! falling through to the base). The order is therefore: curated stdlib →
//! memory limit → STRIP dangerous base leftovers → `sandbox(true)` → inject the
//! host API. `os`/`io`/`package`/`debug`/`load`/`dofile`/`loadfile` are already
//! absent under the curated stdlib; the strip list nils them too, defensively.
//!
//! ## The host API — the entire outside-world surface
//!
//! After `sandbox(true)` we inject four globals into the (writable) sandbox
//! environment. Because the base libraries are frozen, and these are the ONLY
//! capability-bearing values a script can see, this list IS the plugin's
//! complete power:
//!
//!   * `ctx` — a READ-ONLY table mirroring [`PlaceholderCtx`] (`repo`, `sha`,
//!     `file`, `files` array, `diff`, `branch`, `ref`); absent fields are nil.
//!     Pure data; also passed to the handler as its single argument.
//!   * `git(args)` — `args` is a Lua array of strings; runs
//!     `git -C <repo_dir> <args…>` with LITERAL argv via `std::process::Command`
//!     (NO shell — so, unlike [`crate::plugin_exec`]'s template path, there is
//!     nothing to inject INTO), bounded by [`crate::procutil::SUBPROCESS_TIMEOUT`]
//!     with no flashed console window. Returns `{ stdout, stderr, code, ok }`.
//!     git can read AND write — that is the same trust boundary as a plugin
//!     shell `run`, but structured and injection-free; the dispatcher snapshots
//!     first when the command/hook is declared `mutates`. CONFINEMENT: git-LEVEL
//!     options that could escape `repo_dir` or config-inject a shell (`-C`, `-c`,
//!     `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`, `--namespace`)
//!     are REJECTED (see [`is_forbidden_git_level_arg`]), so — unlike a raw shell
//!     `run` — git() genuinely stays inside the open repo and can't turn a config
//!     value (`alias.*`/`core.pager`/`core.sshCommand`) into a shell exec.
//!   * `tama.react(kind, msg)` — if `kind` is one of the SAFE allowlist
//!     `info|busy|ok|problem`, appends a `::gitcat.tama <kind> <msg>` line to the
//!     output buffer so the EXISTING frontend pipeline (`parseTamaReaction`)
//!     surfaces it. Any other `kind` is IGNORED — a script must NOT be able to
//!     reach a safety-critical Tama pose (`danger`/`warn`/`rescue`/…). Returns nil.
//!   * `print(...)` — `tostring` each arg, tab-join, append + newline to the
//!     output buffer (does not touch the real stdout).
//!
//! We do NOT expose `json` here: `LuaSerdeExt` needs mlua's `serialize`
//! feature, which this crate does not enable (`features = ["luau"]`), and the
//! runtime works fine without it.
//!
//! ## Hard limits (defense against a hostile/buggy script)
//!
//!   * MEMORY — `set_memory_limit(64 MiB)`: any allocation past the ceiling
//!     becomes an `Error::MemoryError`, so a `while true do t[#t+1]=t end`
//!     memory bomb terminates as an `Err` instead of exhausting the process.
//!   * TIME — a 5s deadline via `set_interrupt`: Luau calls the interrupt on
//!     loop back-edges / call boundaries, and once the captured `Instant` is
//!     older than the deadline we return an `Err` from it, which Luau raises to
//!     abort the VM. So `while true do end` (which no memory limit would ever
//!     catch) still terminates as an `Err`.
//!
//! Both limits, plus any Lua compile/runtime error, plus a missing/ill-typed
//! handler, surface as `Err(String)` from [`run_lua_handler`], which the
//! dispatcher reports as a command failure.
//!
//! ## Caveat found while building this
//!
//! The `print`/`tama.react` closures capture an `Rc<RefCell<String>>` output
//! buffer, which is `!Send`. That is fine because this crate builds mlua WITHOUT
//! its `send` feature (so `MaybeSend` has a blanket impl and callbacks need not
//! be `Send`). If mlua's `send` feature is ever enabled, the buffer must become
//! `Arc<Mutex<…>>` — a compile error, so it can't regress silently. Each call
//! also builds a FRESH VM (no state leaks between plugin invocations).

use std::cell::RefCell;
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

use mlua::{Lua, LuaOptions, StdLib, Table, Value, Variadic, VmState};

use crate::plugin_exec::{CommandOutput, PlaceholderCtx};
use crate::procutil::NoConsoleWindowExt;

/// Memory ceiling for a plugin VM. Generous enough for real scripting work,
/// small enough that a memory bomb dies quickly as an `Err` rather than
/// pressuring the host process.
const LUA_MEMORY_LIMIT: usize = 64 * 1024 * 1024; // 64 MiB

/// Wall-clock budget for ONE handler invocation. Enforced via `set_interrupt`
/// (see the module doc). Long enough for a handler that shells out to a few
/// `git` calls, short enough that a runaway loop becomes a visible failure fast.
const LUA_DEADLINE: Duration = Duration::from_secs(5);

/// The SAFE allowlist of Tama reaction kinds a script may emit — mirrors the
/// frontend's closed `TAMA_REACTIONS` table (info/busy/ok/problem). Anything
/// else is silently ignored so a script can never impersonate a safety-critical
/// GitCat pose (`danger`/`warn`/`rescue`/`undo`/…).
const TAMA_ALLOWLIST: &[&str] = &["info", "busy", "ok", "problem"];

/// Base-library globals we DELETE before `sandbox(true)` freezes the globals
/// (see the module doc's "sandbox caveat"). `require` is the security-critical
/// one — mlua's Luau `require` is a real filesystem module loader, so leaving it
/// reachable would be a sandbox escape. `loadstring` (runtime source compile),
/// `getfenv`/`setfenv` (env manipulation) and `newproxy` are footguns removed
/// for defense-in-depth; `load`/`dofile`/`loadfile` are already absent under the
/// curated stdlib but nil'd here so the guarantee doesn't depend on that.
const STRIPPED_GLOBALS: &[&str] = &[
    "require", "loadstring", "load", "dofile", "loadfile", "getfenv", "setfenv", "newproxy",
    // pcall/xpcall are stripped for TWO reasons (adversarial review): (1) recursion
    // THROUGH a protected call (`local function f() pcall(f) end f()`) consumes real
    // NATIVE C stack per frame, unbounded by Luau's Lua-level call-depth guard, so it
    // overflows the OS thread stack and SIGABRTs the whole PROCESS — an uncatchable
    // crash a plugin could trigger on every commit via a hook. A native stack
    // overflow cannot be caught in-process, so the only fix is to remove the vector.
    // (2) Removing them also makes the deadline/memory Err strictly UNCATCHABLE — a
    // script can no longer pcall-around the timeout. They are not part of the host
    // API surface (ctx/git/tama/print), so scripts lose nothing they were promised;
    // a plain runtime error just propagates to GitCat as a clean Err.
    "pcall", "xpcall",
];

/// Run one named handler from a plugin's main Lua `script_src` inside a fresh
/// sandboxed Luau VM, with the curated host API bound to `ctx` / `repo_dir`.
///
/// `Ok(CommandOutput)` means the handler RAN: `stdout` holds — in execution
/// order — everything `print()`ed, every allowlisted `tama.react` line, then
/// (if the handler returned a string) that string; `success` is always `true`
/// and `exit_code` is `Some(0)`. `Err(String)` means a Lua compile/runtime
/// error, the memory or time limit, or a missing/ill-typed handler — the
/// dispatcher surfaces it as a command failure.
///
/// See [`run_handler_inner`] for the implementation; this pins the production
/// [`LUA_MEMORY_LIMIT`] / [`LUA_DEADLINE`] so the tests can drive the same core
/// with a tiny deadline / memory ceiling.
pub fn run_lua_handler(
    script_src: &str,
    handler_name: &str,
    ctx: &PlaceholderCtx,
    repo_dir: &str,
) -> Result<CommandOutput, String> {
    run_handler_inner(script_src, handler_name, ctx, repo_dir, LUA_MEMORY_LIMIT, LUA_DEADLINE)
}

/// The core of [`run_lua_handler`], parameterized on the two hard limits so a
/// test can use a small deadline / memory ceiling without a slow real run.
fn run_handler_inner(
    script_src: &str,
    handler_name: &str,
    ctx: &PlaceholderCtx,
    repo_dir: &str,
    memory_limit: usize,
    deadline: Duration,
) -> Result<CommandOutput, String> {
    // 1. Curated-stdlib VM: string/math/table + Luau's always-on base library;
    //    NOT os/io/package/debug. (Luau's base still exposes a filesystem
    //    `require` etc. — those are stripped in step 3.)
    let lua = Lua::new_with(StdLib::STRING | StdLib::MATH | StdLib::TABLE, LuaOptions::default())
        .map_err(|e| format!("could not create the sandboxed Lua VM: {e}"))?;

    // 2. Memory ceiling BEFORE any script runs — stops allocation bombs.
    lua.set_memory_limit(memory_limit)
        .map_err(|e| format!("could not apply the Lua memory limit: {e}"))?;

    // 3. Strip Luau's dangerous always-on base globals (esp. the filesystem
    //    `require`) while the globals table is still writable — see the module
    //    doc's "sandbox caveat". This MUST precede the freeze below.
    strip_dangerous_globals(&lua).map_err(|e| format!("could not harden the Lua globals: {e}"))?;

    // 4. Luau sandbox: freeze the (now-stripped) globals read-only, fresh
    //    per-thread env.
    lua.sandbox(true).map_err(|e| format!("could not enable the Lua sandbox: {e}"))?;

    // Shared, single-threaded output buffer for print() + tama.react(). `!Send`
    // is fine without mlua's `send` feature (see the module doc's caveat).
    let out_buf = Rc::new(RefCell::new(String::new()));

    // 5. Inject the entire host API into the (writable) sandbox environment.
    let ctx_table =
        install_host_api(&lua, ctx, repo_dir, &out_buf).map_err(|e| format!("could not install the plugin host API: {e}"))?;

    // 6. Time budget: Luau fires this on loop back-edges / calls; once we're past
    //    the deadline, returning an Err aborts the VM (catches infinite loops a
    //    memory limit never would).
    let start = Instant::now();
    lua.set_interrupt(move |_| {
        if start.elapsed() > deadline {
            Err(mlua::Error::runtime(format!("plugin handler exceeded its {deadline:?} time budget")))
        } else {
            Ok(VmState::Continue)
        }
    });

    // 7. Load + evaluate the main file; it MUST `return` a table of handlers.
    let module: Value = lua
        .load(script_src)
        .set_name("plugin")
        .eval()
        .map_err(|e| format!("plugin script error: {e}"))?;
    let handlers = match module {
        Value::Table(t) => t,
        other => {
            return Err(format!(
                "the plugin's main Lua file must `return` a table of handler functions, but it returned a {}",
                other.type_name()
            ))
        }
    };

    // 8. Look up the requested handler — clear error if missing or not a function.
    let handler = match handlers.get::<Value>(handler_name).map_err(|e| format!("plugin script error: {e}"))? {
        Value::Function(f) => f,
        Value::Nil => {
            return Err(format!("the plugin handler '{handler_name}' was not found in the table its main file returned"))
        }
        other => {
            return Err(format!("the plugin handler '{handler_name}' is a {}, not a function", other.type_name()))
        }
    };

    // 9. Call it with the ctx table as its single argument.
    let ret: Value = handler.call(ctx_table).map_err(|e| format!("plugin handler error: {e}"))?;

    // 10. Assemble stdout: buffered print/tama output, then the returned string.
    let mut stdout = out_buf.borrow().clone();
    if let Value::String(s) = ret {
        stdout.push_str(&s.to_string_lossy());
    }
    Ok(CommandOutput { stdout, exit_code: Some(0), success: true })
}

/// Delete every [`STRIPPED_GLOBALS`] name from `lua`'s (still-writable) globals
/// table. MUST be called BEFORE `sandbox(true)`: the freeze then locks in a base
/// that lacks them, so they are `nil` to the script. Doing it afterwards would
/// fail (frozen table) or, even if it didn't, a nil entry would just fall
/// through the sandbox's read-only `__index` back to the base copy. See the
/// module doc's "sandbox caveat".
fn strip_dangerous_globals(lua: &Lua) -> mlua::Result<()> {
    let globals = lua.globals();
    for name in STRIPPED_GLOBALS {
        globals.set(*name, Value::Nil)?;
    }
    Ok(())
}

/// Bind `ctx`, `git`, `tama`, and `print` into `lua`'s sandbox globals and
/// return the `ctx` table handle (so the caller can pass the very same table to
/// the handler). Called AFTER `sandbox(true)`, so these land in the writable
/// per-thread env and shadow the frozen base `print`.
/// True if `a` is a git-LEVEL option (used before the subcommand) that would let
/// a script's `git()` call break out of the open repo or turn a config value into
/// a shell exec. See the guard in the `git` host function.
fn is_forbidden_git_level_arg(a: &str) -> bool {
    a == "-C"
        || a == "-c"
        || a.starts_with("--git-dir")
        || a.starts_with("--work-tree")
        || a.starts_with("--exec-path")
        || a.starts_with("--config-env")
        || a.starts_with("--namespace")
}

fn install_host_api(lua: &Lua, ctx: &PlaceholderCtx, repo_dir: &str, out_buf: &Rc<RefCell<String>>) -> mlua::Result<Table> {
    let globals = lua.globals();

    // ---- ctx: read-only data mirror of PlaceholderCtx -----------------------
    let ctx_table = build_ctx_table(lua, ctx)?;
    globals.set("ctx", ctx_table.clone())?;

    // ---- git(args): literal-argv git in repo_dir, no shell ------------------
    let repo = repo_dir.to_string();
    let git_fn = lua.create_function(move |lua, args: Table| {
        // Collect the array of string args (numbers coerce; anything else errors
        // — but there's no shell here, so an argv element is inert DATA regardless).
        let mut argv: Vec<String> = Vec::new();
        for v in args.sequence_values::<String>() {
            argv.push(v?);
        }
        // Confinement: reject git-LEVEL options (those before the subcommand) that
        // could escape repo_dir or config-inject a shell — `-C`/`--git-dir`/
        // `--work-tree`/`--exec-path` override the repo, and `-c`/`--config-env` can
        // set alias.*/core.pager/core.sshCommand to `!sh …` so git execs a shell.
        // Flags AFTER the subcommand (e.g. `git log -c`) can't rebind the repo, so
        // they're left alone. This keeps git() genuinely confined to the open repo —
        // a real step up from a raw shell `run`.
        for a in &argv {
            if !a.starts_with('-') {
                break; // reached the subcommand
            }
            if is_forbidden_git_level_arg(a) {
                return Err(mlua::Error::runtime(format!(
                    "git(): the git-level option {a:?} is not allowed — it could escape the repository or config-inject a shell"
                )));
            }
        }
        let mut cmd = Command::new("git");
        cmd.no_console_window();
        cmd.arg("-C").arg(&repo).args(&argv);
        let out = crate::procutil::output_with_timeout(cmd, crate::procutil::SUBPROCESS_TIMEOUT)
            .map_err(|e| mlua::Error::runtime(format!("git could not run (or timed out): {e}")))?;
        let result = lua.create_table()?;
        result.set("stdout", String::from_utf8_lossy(&out.stdout).into_owned())?;
        result.set("stderr", String::from_utf8_lossy(&out.stderr).into_owned())?;
        result.set("code", out.status.code())?; // Option<i32> -> integer, or nil if signal-killed
        result.set("ok", out.status.success())?;
        Ok(result)
    })?;
    globals.set("git", git_fn)?;

    // ---- tama.react(kind, msg): allowlisted mood nudge ----------------------
    let tama_buf = out_buf.clone();
    let react = lua.create_function(move |_, (kind, msg): (String, Option<String>)| {
        if TAMA_ALLOWLIST.contains(&kind.as_str()) {
            // Keep one react == one protocol line: strip CR/LF from the message
            // so a script can't inject extra `::gitcat.tama …` lines (the
            // frontend would reject a non-allowlisted kind anyway, but this keeps
            // the buffer clean and unspoofable).
            let msg = msg.unwrap_or_default().replace(['\r', '\n'], " ");
            tama_buf.borrow_mut().push_str(&format!("::gitcat.tama {kind} {msg}\n"));
        }
        // Any other kind is silently ignored; always returns nil.
        Ok(())
    })?;
    let tama = lua.create_table()?;
    tama.set("react", react)?;
    tama.set_readonly(true);
    globals.set("tama", tama)?;

    // ---- print(...): capture to the buffer, don't touch real stdout ---------
    let print_buf = out_buf.clone();
    let print_fn = lua.create_function(move |lua, args: Variadic<Value>| {
        let mut line = String::new();
        for (i, v) in args.iter().enumerate() {
            if i > 0 {
                line.push('\t');
            }
            line.push_str(&lua_tostring(lua, v)?);
        }
        line.push('\n');
        print_buf.borrow_mut().push_str(&line);
        Ok(())
    })?;
    globals.set("print", print_fn)?;

    Ok(ctx_table)
}

/// Build the READ-ONLY `ctx` table from a [`PlaceholderCtx`]: scalar fields are
/// set only when present (absent -> nil), `files` is always an array (possibly
/// empty). Both the outer table and the `files` array are frozen read-only so a
/// handler cannot mutate its input.
fn build_ctx_table(lua: &Lua, ctx: &PlaceholderCtx) -> mlua::Result<Table> {
    let t = lua.create_table()?;
    if let Some(v) = &ctx.repo {
        t.set("repo", v.as_str())?;
    }
    if let Some(v) = &ctx.sha {
        t.set("sha", v.as_str())?;
    }
    if let Some(v) = &ctx.file {
        t.set("file", v.as_str())?;
    }
    if let Some(v) = &ctx.diff {
        t.set("diff", v.as_str())?;
    }
    if let Some(v) = &ctx.branch {
        t.set("branch", v.as_str())?;
    }
    if let Some(v) = &ctx.gitref {
        t.set("ref", v.as_str())?;
    }
    let files = lua.create_table()?;
    for (i, f) in ctx.files.iter().enumerate() {
        files.set(i + 1, f.as_str())?; // Lua arrays are 1-based
    }
    files.set_readonly(true);
    t.set("files", files)?;
    t.set_readonly(true);
    Ok(t)
}

/// `print`-style stringify: fast paths for scalars, and for tables/functions/etc
/// defer to the base `tostring` (kept by the sandbox) for a faithful `type: 0x…`
/// representation, falling back to the type name if `tostring` is somehow gone.
fn lua_tostring(lua: &Lua, v: &Value) -> mlua::Result<String> {
    Ok(match v {
        Value::Nil => "nil".to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Integer(i) => i.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.to_string_lossy(),
        other => match lua.globals().get::<mlua::Function>("tostring") {
            Ok(tostring) => tostring.call::<String>(other.clone())?,
            Err(_) => other.type_name().to_string(),
        },
    })
}

#[cfg(test)]
mod probe {
    #[test]
    fn luau_sandbox_evaluates_and_blocks_the_os_library() {
        // The real sandbox recipe: load ONLY a safe stdlib subset (string/math/
        // table) — NOT os/io/package/debug — then enable Luau sandbox mode
        // (freezes globals + Luau safety features). sandbox(true) alone does NOT
        // remove os/io; the curated StdLib set is what keeps them unreachable.
        let lua = mlua::Lua::new_with(
            mlua::StdLib::STRING | mlua::StdLib::MATH | mlua::StdLib::TABLE,
            mlua::LuaOptions::default(),
        )
        .expect("create curated-stdlib VM");
        lua.sandbox(true).expect("enable Luau sandbox");

        // Pure computation + the safe stdlibs work.
        let n: i64 = lua.load("return 40 + 2").eval().expect("eval");
        assert_eq!(n, 42);
        let s: String = lua.load("return string.upper('hi')").eval().expect("string lib");
        assert_eq!(s, "HI");

        // The dangerous libraries are unreachable — no filesystem / process.
        let no_os: bool = lua.load("return os == nil").eval().expect("os check");
        let no_io: bool = lua.load("return io == nil").eval().expect("io check");
        assert!(no_os, "os library must be absent in the sandbox");
        assert!(no_io, "io library must be absent in the sandbox");
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;

    // Convenience: run against the PRODUCTION limits (what plugins really get).
    fn run(src: &str, handler: &str, ctx: &PlaceholderCtx, repo_dir: &str) -> Result<CommandOutput, String> {
        run_lua_handler(src, handler, ctx, repo_dir)
    }

    // A temp dir for `git`-touching tests (also used as an inert repo_dir when a
    // test doesn't touch git at all).
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "gitcat-plugin-lua-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ---- return value + print capture ---------------------------------------

    #[test]
    fn handler_returning_a_string_yields_it_in_stdout() {
        let src = "local M = {}\nfunction M.run(ctx) return 'hello from lua' end\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "hello from lua");
        assert_eq!(out.exit_code, Some(0));
        assert!(out.success);
    }

    #[test]
    fn print_output_is_captured_tab_joined_and_newline_terminated() {
        let src = "local M = {}\nfunction M.run(ctx)\n  print('line one')\n  print('a', 'b', 1)\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "line one\na\tb\t1\n");
        assert!(out.success);
    }

    // ---- security regressions (adversarial review) --------------------------

    #[test]
    fn pcall_and_xpcall_are_stripped_so_native_stack_recursion_cannot_crash() {
        let ctx = PlaceholderCtx::default();
        // Both are nil (removed) — a script sees nothing to protect-call with.
        let probe = "local M={} function M.run() return tostring(pcall) .. '|' .. tostring(xpcall) end return M";
        assert_eq!(run(probe, "run", &ctx, ".").expect("runs").stdout, "nil|nil");
        // The reviewer's SIGABRT reproducer: recursion through the (now-nil) pcall
        // must surface as a clean Err, never crash the process.
        let repro = "local M={} function M.run() local function f() pcall(f) end f() end return M";
        assert!(run(repro, "run", &ctx, ".").is_err(), "pcall-recursion must be a clean Err, not a crash");
    }

    #[test]
    fn git_rejects_repo_escaping_and_config_injecting_git_level_options() {
        let dir = tmp_dir("git-guard");
        let repo = dir.to_str().unwrap();
        let ctx = PlaceholderCtx::default();
        for bad in ["-C", "-c", "--git-dir=/x", "--work-tree=/y", "--exec-path=/z", "--config-env=x", "--namespace=n"] {
            let src = format!("local M={{}} function M.run() return git({{'{bad}','log'}}).ok end return M");
            assert!(run(&src, "run", &ctx, repo).is_err(), "git-level option {bad:?} must be rejected");
        }
        // A normal (subcommand) call still works — the guard only blocks git-level flags.
        let ok = "local M={} function M.run() return tostring(git({'--version'}).ok) end return M";
        assert_eq!(run(ok, "run", &ctx, repo).expect("git --version runs").stdout, "true");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn print_output_then_returned_string_are_in_order() {
        let src = "local M = {}\nfunction M.run(ctx)\n  print('first')\n  return 'second'\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "first\nsecond");
    }

    // ---- tama.react allowlist ------------------------------------------------

    #[test]
    fn tama_react_allowlisted_emits_the_directive_line() {
        let src = "local M = {}\nfunction M.run(ctx) tama.react('ok', 'hi') end\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "::gitcat.tama ok hi\n");
    }

    #[test]
    fn tama_react_every_allowlisted_kind_is_accepted() {
        let src = "local M = {}\nfunction M.run(ctx)\n  tama.react('info','a')\n  tama.react('busy','b')\n  tama.react('ok','c')\n  tama.react('problem','d')\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(
            out.stdout,
            "::gitcat.tama info a\n::gitcat.tama busy b\n::gitcat.tama ok c\n::gitcat.tama problem d\n"
        );
    }

    #[test]
    fn tama_react_non_allowlisted_kind_is_ignored() {
        // A script must NOT be able to reach a safety-critical pose.
        let src = "local M = {}\nfunction M.run(ctx)\n  tama.react('danger', 'boom')\n  tama.react('warn', 'x')\n  tama.react('rescue', 'y')\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "", "no directive line may be emitted for a non-allowlisted kind");
        assert!(!out.stdout.contains("gitcat.tama"));
    }

    #[test]
    fn tama_react_message_cannot_inject_a_second_directive_line() {
        // A newline in the message is neutralized so one react == one line.
        let src = "local M = {}\nfunction M.run(ctx) tama.react('ok', 'a\\n::gitcat.tama danger boom') end\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        assert_eq!(out.stdout, "::gitcat.tama ok a ::gitcat.tama danger boom\n");
        assert_eq!(out.stdout.lines().count(), 1, "message newline must not create a second directive line");
    }

    // ---- ctx read-only mirror ------------------------------------------------

    #[test]
    fn ctx_fields_are_readable_including_the_files_array() {
        let ctx = PlaceholderCtx {
            sha: Some("deadbeef".into()),
            branch: Some("main".into()),
            files: vec!["a.txt".into(), "b.txt".into()],
            ..Default::default()
        };
        let src = "local M = {}\nfunction M.run(ctx) return ctx.sha..' '..ctx.branch..' '..ctx.files[2]..' '..#ctx.files end\nreturn M";
        let out = run(src, "run", &ctx, ".").expect("should run");
        assert_eq!(out.stdout, "deadbeef main b.txt 2");
    }

    #[test]
    fn ctx_absent_fields_are_nil() {
        let ctx = PlaceholderCtx { sha: Some("x".into()), ..Default::default() };
        let src = "local M = {}\nfunction M.run(ctx) return tostring(ctx.sha)..'|'..tostring(ctx.diff)..'|'..tostring(ctx.repo) end\nreturn M";
        let out = run(src, "run", &ctx, ".").expect("should run");
        assert_eq!(out.stdout, "x|nil|nil");
    }

    #[test]
    fn ctx_is_read_only() {
        // Mutating the input must fail (readonly table) -> the handler errors.
        let src = "local M = {}\nfunction M.run(ctx) ctx.sha = 'tampered' return 'ok' end\nreturn M";
        let res = run(src, "run", &PlaceholderCtx { sha: Some("orig".into()), ..Default::default() }, ".");
        assert!(res.is_err(), "writing to the read-only ctx table must error, got: {res:?}");
    }

    // ---- git host function ---------------------------------------------------

    #[test]
    fn git_runs_version_and_returns_ok_stdout() {
        let dir = tmp_dir("git-version");
        let src = "local M = {}\nfunction M.run(ctx)\n  local r = git({'--version'})\n  if not r.ok then return 'FAIL '..r.stderr end\n  return r.stdout\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), dir.to_str().unwrap()).expect("should run");
        assert!(out.stdout.contains("git version"), "unexpected git --version output: {:?}", out.stdout);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_c_routing_reads_the_repo_dir() {
        // Prove `git -C <repo_dir>` targets the intended repo: init one, then
        // have the handler ask git whether it's inside a work tree.
        let dir = tmp_dir("git-repo");
        let init = Command::new("git").arg("-C").arg(&dir).arg("init").output().expect("git init");
        assert!(init.status.success(), "git init failed: {}", String::from_utf8_lossy(&init.stderr));
        // `git()` returns raw (untrimmed) stdout, so strip the trailing newline
        // in-Lua before comparing; also proves ok=true and code=0.
        let src = "local M = {}\nfunction M.run(ctx)\n  local r = git({'rev-parse', '--is-inside-work-tree'})\n  return tostring(r.ok)..':'..tostring(r.code)..':'..(r.stdout:gsub('%s',''))\nend\nreturn M";
        let out = run(src, "run", &PlaceholderCtx::default(), dir.to_str().unwrap()).expect("should run");
        assert_eq!(out.stdout, "true:0:true");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- shipped example: commit-subject-lint -------------------------------

    #[test]
    fn shipped_commit_subject_lint_reacts_ok_for_short_and_problem_for_long() {
        // Runs the ACTUAL examples/plugins/commit-subject-lint/main.lua against a
        // real temp repo, so the shipped Luau example can't silently rot (a syntax
        // error, a renamed handler, or a broken git() call fails this test). Only
        // the `lint_head` command handler is exercised; `on_commit` shares the same
        // private lint()/report() path.
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../examples/plugins/commit-subject-lint/main.lua"),
        )
        .expect("read shipped commit-subject-lint main.lua");

        let dir = tmp_dir("subject-lint");
        // The handler reads via git() in repo_dir, so ctx can stay default.
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&dir).args(args).output().expect("git");
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init"]);
        git(&["config", "user.email", "lint@example.com"]);
        git(&["config", "user.name", "Lint Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("f.txt"), "one").unwrap();
        git(&["add", "."]);

        let repo = dir.to_str().unwrap();
        let ctx = PlaceholderCtx::default();

        // A short, clean subject -> Tama's "ok".
        git(&["commit", "-m", "Add a short clean subject"]);
        let out = run(&src, "lint_head", &ctx, repo).expect("lint_head runs");
        assert!(out.stdout.contains("::gitcat.tama ok"), "short subject should be ok, got: {:?}", out.stdout);
        assert!(!out.stdout.contains("::gitcat.tama problem"), "short subject must not be a problem: {:?}", out.stdout);

        // A subject well over 72 chars -> Tama's "problem".
        std::fs::write(dir.join("f.txt"), "two").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", &"x".repeat(90)]);
        let out = run(&src, "lint_head", &ctx, repo).expect("lint_head runs");
        assert!(out.stdout.contains("::gitcat.tama problem"), "long subject should be a problem, got: {:?}", out.stdout);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- sandbox: dangerous libraries absent --------------------------------

    #[test]
    fn dangerous_globals_are_all_nil() {
        // The withheld libraries (os/io/package/debug) AND the stripped base
        // leftovers (require/loadstring/getfenv/setfenv/newproxy/load/dofile/
        // loadfile) must all be unreachable — no filesystem module loader, no
        // process spawning, no code loading, no env manipulation. `require` is
        // the security-critical one: mlua's Luau `require` is a real FS loader.
        let names = [
            "os", "io", "package", "debug", "require", "loadstring", "load", "dofile", "loadfile",
            "getfenv", "setfenv", "newproxy",
        ];
        let checks = names.iter().map(|n| format!("tostring({n})")).collect::<Vec<_>>().join("..'|'..");
        let src = format!("local M = {{}}\nfunction M.run(ctx) return {checks} end\nreturn M");
        let out = run(&src, "run", &PlaceholderCtx::default(), ".").expect("should run");
        let expected = names.iter().map(|_| "nil").collect::<Vec<_>>().join("|");
        assert_eq!(out.stdout, expected, "some dangerous global was reachable: {:?}", out.stdout);
    }

    // ---- hard limits ---------------------------------------------------------

    #[test]
    fn infinite_loop_terminates_via_the_deadline() {
        // A small deadline so the test is fast; `while true do end` allocates
        // nothing, so ONLY the time budget can stop it.
        let src = "local M = {}\nfunction M.run(ctx) while true do end end\nreturn M";
        let res = run_handler_inner(
            src,
            "run",
            &PlaceholderCtx::default(),
            ".",
            LUA_MEMORY_LIMIT,
            Duration::from_millis(200),
        );
        assert!(res.is_err(), "an infinite loop must terminate as an Err via the deadline, got: {res:?}");
    }

    #[test]
    fn memory_bomb_is_bounded() {
        // A small memory ceiling so the bomb dies fast; a backstop deadline keeps
        // the test from hanging if accounting ever changed.
        let src = "local M = {}\nfunction M.run(ctx)\n  local t = {}\n  local i = 0\n  while true do i = i + 1 t[i] = i end\nend\nreturn M";
        let res = run_handler_inner(
            src,
            "run",
            &PlaceholderCtx::default(),
            ".",
            8 * 1024 * 1024, // 8 MiB
            Duration::from_secs(3),
        );
        assert!(res.is_err(), "a memory bomb must terminate as an Err, got: {res:?}");
    }

    // ---- handler lookup + malformed modules ----------------------------------

    #[test]
    fn missing_handler_is_a_clear_error() {
        let src = "local M = {}\nfunction M.other() end\nreturn M";
        let res = run(src, "run", &PlaceholderCtx::default(), ".");
        let err = res.expect_err("a missing handler must error");
        assert!(err.contains("run"), "error should name the handler: {err}");
    }

    #[test]
    fn handler_that_is_not_a_function_is_rejected() {
        let src = "return { run = 5 }";
        let res = run(src, "run", &PlaceholderCtx::default(), ".");
        let err = res.expect_err("a non-function handler must error");
        assert!(err.contains("not a function"), "unexpected error: {err}");
    }

    #[test]
    fn main_file_not_returning_a_table_is_rejected() {
        let src = "return 42";
        let res = run(src, "run", &PlaceholderCtx::default(), ".");
        let err = res.expect_err("a non-table module must error");
        assert!(err.contains("table"), "unexpected error: {err}");
    }

    #[test]
    fn a_syntax_error_surfaces_as_err() {
        let src = "this is not valid lua ===";
        let res = run(src, "run", &PlaceholderCtx::default(), ".");
        assert!(res.is_err(), "a compile error must be an Err");
    }

    #[test]
    fn a_runtime_error_inside_the_handler_surfaces_as_err() {
        let src = "local M = {}\nfunction M.run(ctx) error('boom') end\nreturn M";
        let res = run(src, "run", &PlaceholderCtx::default(), ".");
        let err = res.expect_err("a runtime error must be an Err");
        assert!(err.contains("boom"), "error should carry the message: {err}");
    }
}
