-- lua-hello: the smallest Luau-scripted GitCat plugin (PER-56).
--
-- A plugin's main .lua file `return`s a table of NAMED handler functions. A
-- command/hook in plugin.json names one via its `handler` field; GitCat runs it
-- inside a locked-down Luau sandbox and passes it a single `ctx` table.
--
-- The whole host API a handler gets:
--   * ctx            -- a read-only table: ctx.repo, ctx.sha, ctx.file,
--                       ctx.files (array), ctx.diff, ctx.branch, ctx.ref
--                       (absent fields are nil) -- the same values as the shell
--                       executor's {repo}/{sha}/... placeholders.
--   * git(args)      -- run `git` (args is an array of strings) in the repo and
--                       get back a table: { stdout, stderr, code, ok }.
--   * tama.react(kind, msg) -- nudge Tama; kind is one of info|busy|ok|problem.
--   * print(...)     -- captured as the command's output (there is no console).
-- No os/io/network, no require/load: a script's only reach outward is git().

local M = {}

-- Invoked by the "hello" command (context: repo, so ctx.repo is set).
function M.hello(ctx)
  -- Ask git for the short HEAD sha. git() never uses a shell, so the argv
  -- elements are literal, injection-free data.
  local head = git({ "rev-parse", "--short", "HEAD" })

  if head.ok then
    -- head.stdout has a trailing newline from git; trim it.
    local sha = (head.stdout:gsub("%s+$", ""))
    print("Hello from Luau! Repo: " .. tostring(ctx.repo))
    print("HEAD is at " .. sha)
    tama.react("ok", "Hello from your Luau plugin — HEAD is " .. sha)
    return "lua-hello: HEAD " .. sha
  else
    -- A non-zero git exit: report it and set a "problem" mood.
    tama.react("problem", "lua-hello could not read HEAD")
    return "lua-hello: could not read HEAD: " .. head.stderr
  end
end

return M
