# Prompt: build your own Git GUI with Claude Code

Open an empty folder in Claude Code and paste everything under the line.

---

Build me a desktop Git GUI that looks and feels like GitKraken, using Electron + React + TypeScript + Vite on
top of the installed `git` CLI. Work in small steps, check the UI yourself in the preview browser, run
typecheck/build/tests after each step, and only commit when I ask (short messages). Make sensible choices
yourself instead of asking me.

**Features**
- Commit graph (lanes, avatars, branch/tag pills, WIP row, stashes, ahead/behind badges), virtualized, with
  search and a sidebar of branches, remotes, tags and stashes.
- Resizable, remembered panels; repository tabs (reorder, rename/alias, per-tab undo, change/conflict badges,
  restored on start).
- Staging and diffs: stage/unstage/discard per file and hunk, word-level highlighting, commit/amend, arrow-key
  navigation that only acts on the focused area (graph or file list).
- Branches: checkout (offer stash & checkout), create, delete (local, remote or both), merge, cherry-pick,
  revert, reset, tags, stash apply/pop/drop, detached-HEAD banner.
- Fetch/pull/push, undo/redo of history-changing actions, GitHub account switching via Git Credential Manager.
- Conflict resolution: operations stop on conflicts with a Continue/Skip/Abort banner; per-block
  ours/theirs/both or manual edit; delete-vs-modify and binary cases; reopen a resolved file.

**Rules**
- Run git only through `spawn` with argument arrays in one backend module, validate every ref and path, use
  machine-readable output, never store credentials.
- Share that backend between Electron (sandboxed, preload bridge) and a dev-only Vite endpoint so the UI is
  testable in a normal browser.
- Test with `node:test` on throw-away repos in a sandboxed environment (private home, local bare repos as
  remotes). Never run real sign-in or pushes.
- Use your own dev-server port and don't kill servers you didn't start.

Start by setting up the repo and showing a short plan, then build it feature by feature.
