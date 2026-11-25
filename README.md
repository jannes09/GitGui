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
npm run dist     # build a portable Windows exe: release/GitGui-<version>-x64.exe
npm run dist:installer   # the same as an installer (release/GitGui-Setup-<version>.exe), the better way to run it daily
npm run icon     # redraw build/icon.png and build/icon.ico (scripts/make-icon.cjs)
npm test         # backend and parser tests against temporary repos
```

Backend changes (`electron/handlers.cjs`) are only picked up after restarting `npm run dev`; UI changes hot reload.

## Layout

- `electron/handlers.cjs` – every git operation (the only place that spawns git)
- `electron/main.cjs`, `preload.cjs` – window and the IPC bridge
- `electron/updates.cjs` – finds and verifies a newer build in a local folder
- `electron/watcher.cjs` – watches the open repositories on disk and tells the window when one changed
- `electron/cloneprogress.cjs` – reads `git clone --progress` output into one overall percentage
- `src/graph.ts` – lane assignment for the commit graph
- `src/components/` – toolbar, sidebar, graph, diff view, commit/staging panel

## What it does

- **Graph and history:** commit graph with avatars and branch/tag pills, WIP row, sidebar (local, remote, stashes, tags), word-level diffs, readable branch names, lane colours and main-lane settings. [Details](docs/graph.md)
- **Changes:** stage / unstage / discard (file and hunk level), commit and amend, fetch / pull / push, checkout, create branch / tag, merge, cherry-pick, revert, reset, stash / pop, commit search.
- **Undo, edit and delete:** Ctrl+Z / Ctrl+Y undo and redo, edit a local commit's message, force push with a safety check, delete branches locally and on the remote. [Details](docs/history.md)
- **Repositories:** tabs with aliases that are restored at start, clone with a progress bar, conflict resolution, automatic refresh when something changes on disk. [Details](docs/repositories.md)
- **GitHub and Azure DevOps:** switch GitHub accounts, open-pull-request badges and shortcuts, the pull request a commit came from, author pictures. [Details](docs/github.md)
- **The app itself:** icon and splash, installer with an optional desktop shortcut, updates from a local folder. [Details](docs/app.md)

Also in the `docs/` folder: [a prompt for building your own Git GUI](docs/build-your-own-git-gui-prompt.md).

## Not done yet

Interactive rebase, light theme, pull request integration, code signing (the exe is unsigned, so
Windows SmartScreen warns about an unknown publisher). The exe needs Git for Windows installed on the computer.
