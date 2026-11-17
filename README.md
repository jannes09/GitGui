# GitGui

A GitKraken-style Git client built with Electron, React and TypeScript. It drives the `git` CLI, so hooks, config, SSH and credential helpers behave exactly as they do in a terminal.

## Run

```bash
npm install
npm run dev      # Electron window with hot reload
npm run web      # same UI in a browser at http://localhost:5173 (dev only; type a repo path)
npm run build    # typecheck + production bundle into dist/
npm start        # run the built bundle in Electron
npm run smoke    # headless check that the Electron shell loads
npm test         # backend and parser tests against temporary repos
```

Backend changes (`electron/handlers.cjs`) are only picked up after restarting `npm run dev`; UI changes hot reload.

## Layout

- `electron/handlers.cjs` – every git operation (the only place that spawns git)
- `electron/main.cjs`, `preload.cjs` – window and the IPC bridge
- `src/graph.ts` – lane assignment for the commit graph
- `src/components/` – toolbar, sidebar, graph, diff view, commit/staging panel

## Done

Commit graph with avatars and branch/tag pills, WIP row, sidebar (local, remote, stashes, tags),
stage / unstage / discard (file and hunk level), commit and amend, fetch / pull / push,
checkout, create branch / tag, merge, cherry-pick, revert, reset, stash / pop, commit search.

**Undo / redo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, plus the toolbar buttons) covers commit, amend, checkout,
create / delete branch, create tag, merge, pull, cherry-pick, revert and reset. Each action is recorded as a
before/after snapshot of HEAD, local branches and tags. Undo is refused if the repository changed outside the
app since, or if it would overwrite local edits. Fetch, push, stash and staging are not undoable.

**Diffs** highlight the exact words that changed inside a modified line. The Up / Down arrows act on whatever has
focus (click it first): in the graph they move the selected commit (PageUp / PageDown / Home / End too); in the
right-hand panel they walk through the changed files (unstaged, then staged, or the files of the selected commit),
opening each diff. The × at the right of a diff closes it (or press Esc).

**Graph:** stashes appear as dashed rows above the commit they were made on (right-click to pop, apply or drop),
branch pills show `↑` / `↓` for unpushed / unpulled commits, and a commit's right-click menu offers checkout and
merge for every branch on it. Double-click a commit that has a branch label to check that branch out. If
uncommitted changes block a checkout you are offered "Stash & checkout".

**GitHub accounts:** the toolbar's account button (profile picture and username) switches which saved account the
repository uses. A switch sets the repository's `user.name`, `user.email` and
`credential.https://github.com.username`, so Git Credential Manager uses that account for fetch / pull / push, and a
small dot shows whether it is signed in. "Manage accounts" adds, edits and removes accounts, signs in or out (via
Git Credential Manager's browser flow) and can set a default for all repositories. If a fetch, pull or push fails
because you are signed out or on the wrong account, the app offers to sign in and retries. Profile pictures are
loaded from `github.com/<username>.png` (only the public username is sent) and fall back to initials. Account
details (username, name, email — never passwords or tokens) are kept in `~/.gitgui/accounts.json`.
Only github.com over HTTPS is affected; SSH remotes just get the commit identity.

**Resizable panels:** drag the dividers beside the sidebar and the details panel, or the edge of the
BRANCH / TAG column header. Double-click resets, arrow keys nudge, and widths are remembered.

**Repository tabs:** every opened repository gets a tab above the toolbar. Click to switch, drag to reorder,
middle-click or the × to close, right-click for more, `+` to open another. Double-click a tab (or press F2, or
right-click → Rename) to give it an alias; the folder is not renamed and "Reset tab name" brings the original back. Each tab keeps its own undo history and
selection, shows its uncommitted-change count (or a warning when it has conflicts), and the open tabs are restored
at the next start. Shortcuts: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9, Ctrl+W, Ctrl+T.

**Conflicts:** merge, cherry-pick, revert, pull and "apply stash" stop on conflicts instead of failing. A banner
shows the operation in progress with Continue, Skip (not for merge) and Abort, and the changes panel lists the
conflicted files. Click one to resolve it: tick Ours and/or Theirs for each conflict block (both keeps ours first),
or use "Edit result" to type the final text. "Mark resolved" saves and stages it and moves to the next file.
Whole-file Ours / Theirs, and Keep / Delete for modify-delete conflicts and binary files, are offered where block
merging is not possible. A resolved file can be reopened while the operation is still in progress. A rebase that
was started elsewhere (or by `pull --rebase`) is handled the same way.

## Not done yet

Interactive rebase, light theme, pull request integration, installer packaging.
