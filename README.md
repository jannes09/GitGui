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
npm test         # undo/redo engine tests against temporary repos
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

**Diffs** highlight the exact words that changed inside a modified line, and Up / Down arrows walk through the
changed files (unstaged, then staged, or the files of the selected commit), opening each diff.

**Graph:** stashes appear as dashed rows above the commit they were made on (right-click to pop, apply or drop),
branch pills show `↑` / `↓` for unpushed / unpulled commits, and a commit's right-click menu offers checkout and
merge for every branch on it. Double-click a commit that has a branch label to check that branch out. If
uncommitted changes block a checkout you are offered "Stash & checkout".

**Resizable panels:** drag the dividers beside the sidebar and the details panel, or the edge of the
BRANCH / TAG column header. Double-click resets, arrow keys nudge, and widths are remembered.

## Not done yet

Interactive rebase, conflict resolution UI, light theme, real avatars, pull request
integration, installer packaging.
