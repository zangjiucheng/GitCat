-- commit-subject-lint (Luau): check a commit's subject line and let Tama react.
--
-- This plugin used to be a POSIX-shell one-liner ($(...), ${#s}, [ ... ]) that
-- only ran under a real shell, so it was brittle on Windows. As a Luau handler
-- the exact same logic runs cross-platform with no shell at all, and two entry
-- points -- a `commit-created` HOOK and an on-demand COMMAND -- share one lint
-- function instead of duplicating a shell string.
--
-- Host API used here: git(args) to read the subject, tama.react(kind, msg) to
-- nudge Tama, and the returned string as the command's textual output. See the
-- lua-hello example for the full host-API tour.

local M = {}

local SUBJECT_MAX = 72

-- Read a revision's subject line via git. argv is literal (no shell -> no
-- injection). Returns the trimmed subject, or nil plus an error message.
local function subject_of(rev)
  local r = git({ "log", "-1", "--format=%s", rev })
  if not r.ok then
    return nil, (r.stderr:gsub("%s+$", ""))
  end
  return (r.stdout:gsub("%s+$", "")) -- git appends a newline; trim it
end

-- The shared rule set. Returns a kind ("ok" | "problem") and a message. Keeping
-- this in a real language (not a shell `test`) is the whole point: adding a rule
-- or reporting a precise reason stays readable.
local function lint(subject)
  local n = #subject -- byte length; fine for the ASCII subjects this targets
  if n > SUBJECT_MAX then
    return "problem", "Subject is " .. n .. " chars (over " .. SUBJECT_MAX .. "). Consider shortening it."
  end
  if subject:sub(-1) == "." then
    return "problem", "Subject ends with a period. Drop the trailing period."
  end
  return "ok", "Subject looks good (" .. n .. " chars)."
end

-- Lint a revision and drive Tama; `where` labels it in the surfaced message.
local function report(rev, where)
  local subject, err = subject_of(rev)
  if not subject then
    tama.react("problem", "commit-subject-lint could not read " .. where .. ": " .. tostring(err))
    return "commit-subject-lint: could not read " .. where .. ": " .. tostring(err)
  end
  local kind, msg = lint(subject)
  tama.react(kind, where .. ": " .. msg)
  return where .. ": " .. msg
end

-- HOOK handler: fires after a commit is made through GitCat's commit UI.
function M.on_commit(ctx)
  return report("HEAD", "New commit")
end

-- COMMAND handler: lint HEAD on demand from the ⌘K palette.
function M.lint_head(ctx)
  return report("HEAD", "HEAD")
end

return M
