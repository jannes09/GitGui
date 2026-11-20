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
- `src/graph.ts` – lane assignment for the commit graph
- `src/components/` – toolbar, sidebar, graph, diff view, commit/staging panel

## Done

Commit graph with avatars and branch/tag pills, WIP row, sidebar (local, remote, stashes, tags),
stage / unstage / discard (file and hunk level), commit and amend, fetch / pull / push,
checkout, create branch / tag, merge, cherry-pick, revert, reset, stash / pop, commit search.

**Undo / redo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, plus the toolbar buttons) covers commit, amend, edit commit message,
checkout, create / delete branch, create tag, merge, pull, cherry-pick, revert and reset. Each action is recorded as a
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

**Pull requests:** for repositories on GitHub or Azure DevOps (https or ssh remotes) the app looks up the open pull
requests and shows `#12` on the branch's pill in the graph and in the sidebar (click it to open the pull request in
your browser). The toolbar gets a shortcut: `PR #12` for the current branch's pull request, `Create PR` for a pushed
branch that has none, or `PRs` for the repository's list. Right-click a branch for "Open pull request…" /
"Create pull request…". Drafts are dimmed and pull requests from forks are ignored. Lookups are read only and use the
login Git Credential Manager already holds for that host (asked for without any prompt, kept in memory for two
minutes, sent only to `api.github.com` / `dev.azure.com`); without a login only public repositories work. They run
when a repository opens, after Fetch, and when the window regains focus (at most every 20 s with a login, 2 min
without). Other hosts simply show no badges.

**Readable branch names:** the BRANCH / TAG column shows the checked-out branch first, then well-known ones
(`main`, `master`, `dev`, `develop`, `staging`, `production`, `release`, `release/*`), then other local branches,
remote-only branches and tags, and when space is short it puts the rest behind a `+N` pill instead of squeezing them. Long names keep their distinctive end (`…/Scheduler-rewrite`), the
remote prefix is dropped when there is only one remote, and hovering a row with shortened pills shows a card with every
branch and tag in full.

**Settings** (the sliders button in the toolbar, or Ctrl+,) switch each of these on or off; changes apply at once and
are remembered. They are about *main lanes*, the first-parent history of your main branches (`main`, `master`, `dev`,
`develop`, `development`, `trunk`, `staging`, `production`, `release`, `release/*` by default; the list is editable
there too):

1. **Bold main lanes:** main lanes are thicker, with bigger commit dots.
2. **Pin to the left:** the topmost main branch always sits in the first lane, so it is one straight column that
   feature branches never push aside (a branch cut from its newest commit joins it instead of taking its place).
3. **Band and bold text:** a soft band behind the main lanes, only along the main line itself, and commit messages on
   the main line in bold.
4. **Colour and labels:** main branches keep a fixed colour (dev teal, main / master gold, other main branches purple),
   and a branch name chip stays above each main lane while you scroll.

Other lanes get a colour that is clearly different from the lanes running beside it (so neighbours never look alike
until the palette of ten runs out), and the same branch name starts from the same colour every time. The name that
counts is the lowest (oldest) branch on the lane: when a branch is stacked on top of another, the whole lane keeps the
lower branch's colour, so stacking a new branch never recolours the one underneath. The hover label still names the
branch at the top of the lane. A lane whose commits carry no branch name is coloured from the "Merge branch 'x'"
message that brought it in, or else takes the next colour in turn. Colours are handed out after the whole loaded
history has been laid out, so loading more history can recolour a lane that has an older branch name further down.

Hover over a commit or a lane line in the graph to see which branch it belongs to. The name comes from the branch
labels on the lane's newest commit, or from a merge message ("Merge branch 'x'", "Merge pull request #1 from user/x");
lanes of branches that were deleted without such a message have no name.

The settings page also has the switch for the pull request lookups.

**Editing commit messages:** right-click a commit and choose "Edit commit message…", or click the pencil beside its
summary in the details panel, to change its summary and description (Enter in the summary jumps to the description,
Ctrl+Enter saves). This works for commits that have not been pushed and that only the checked-out branch holds, so
nothing is left behind with the old message; otherwise the item is greyed out and the tooltip says why (already on a
remote, also on another branch, tagged, or a merge / rebase is in progress). A message is part of a commit's id, so the
commit and the commits after it on the branch are rebuilt with new ids. Their files, authors, dates and messages stay
the same; the edited commit's committer becomes you, as with `git commit --amend`. The working tree and staged changes
are not touched, nothing can conflict, and Ctrl+Z puts the old commits back. At most 250 later commits are rebuilt
(about 0.1 s each) and GPG signatures on rebuilt commits are dropped. It is done with `git commit-tree` and one
`git update-ref`, not a rebase, and commit-msg hooks are not run.

**Deleting branches:** right-click a commit (or a branch in the sidebar) to delete a local branch, its copy on the
remote (`git push --delete`), or both. Deleting the local copy is undoable and git refuses it, with an
"Delete anyway" prompt, if it has unmerged commits; remote deletion always asks first and cannot be undone.

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

**Icon and splash:** the app icon is a white commit graph on a bright teal-to-blue tile, drawn at every size from the
vector (the small sizes use heavier lines) so it stays visible on a taskbar; `npm run icon` redraws it. On start a
small splash window shows a commit graph drawing itself (one branch leaves the main line and merges back) for at least
1.8 s while the main window loads, then fades out. The app's version number appears under the name. It is
`electron/splash.html`, pure CSS (the main process writes the version into it before loading, see `electron/splash-page.cjs`),
and follows the system's reduced-motion setting. `GITGUI_SPLASH_LOG=1` prints the splash timing and quits, for checking
the sequence.

**Version number:** shown on the splash and next to the title of the Settings dialog (`GitGui 0.2.0`). It is the
`version` in `package.json`, so raising it there (see Updates below) changes both after the next build.

**Portable exe or installer:** the portable exe unpacks the whole app (about 315 MB) into a temp folder every time it
starts, which takes around 9 s before the splash can appear. The installer (`npm run dist:installer`, per-user, no
admin rights needed) unpacks once, so the splash shows within half a second. Use the installer for daily use and pin the
installed shortcut; the portable exe is for carrying the app around.

**Updates from a local folder:** when GitGui starts it looks in a folder on this computer for a newer build and, if there
is one, asks whether to install it (Install and restart, Later, or Skip this version). Nothing is downloaded and nothing
leaves the computer. The folder is the one `npm run dist` / `dist:installer` write to (`release/`); the build records
that path, so it works without any setup, and Settings → Updates can point it somewhere else, switch the start-up
check off, check right now (that ignores a skipped version) or ask about a skipped version again. It reads `latest.yml`
and the `GitGui-Setup-<version>.exe` it names, and a build counts as newer only when its version number is higher than
the running app's, so raise `version` in `package.json` (for example `npm version minor --no-git-tag-version`) before
building a release. Before the installer is started it is checked against the SHA-512 in `latest.yml`, so a damaged or
half-written file is refused. Installing starts the installer and closes GitGui; the installer keeps your settings and
repositories and offers to start the new version when it is done. The portable exe and a source checkout cannot be
replaced in place, so for them the installer is only shown in its folder.

## Not done yet

Interactive rebase, light theme, pull request integration, code signing (the exe is unsigned, so
Windows SmartScreen warns about an unknown publisher). The exe needs Git for Windows installed on the computer.
