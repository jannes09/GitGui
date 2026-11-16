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
```

## Layout

- `electron/handlers.cjs` – every git operation (the only place that spawns git)
- `electron/main.cjs`, `preload.cjs` – window and the IPC bridge
- `src/graph.ts` – lane assignment for the commit graph
- `src/components/` – toolbar, sidebar, graph, diff view, commit/staging panel

## Done

Commit graph with avatars and branch/tag pills, WIP row, sidebar (local, remote, stashes, tags),
stage / unstage / discard (file and hunk level), commit and amend, fetch / pull / push,
checkout, create branch / tag, merge, cherry-pick, revert, reset, stash / pop, commit search.

## Not done yet

Undo/redo, interactive rebase, conflict resolution UI, resizable panels, light theme,
real avatars, pull request integration, installer packaging.
