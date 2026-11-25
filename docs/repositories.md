# Repository tabs, cloning and conflicts

Part of the [GitGui README](../README.md).

**Repository tabs:** every opened repository gets a tab above the toolbar. Click to switch, drag to reorder,
middle-click or the × to close, right-click for more, `+` to open or clone another repository. Double-click a tab (or press F2, or
right-click → Rename) to give it an alias; the folder is not renamed and "Reset tab name" brings the original back. Each tab keeps its own undo history and
selection, shows its uncommitted-change count (or a warning when it has conflicts), and the open tabs are restored
at the next start. Shortcuts: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9, Ctrl+W, Ctrl+T.

**Cloning:** "Clone repository…" is in the repo menu, behind the `+` at the end of the tabs, and on the welcome screen. Enter
the repository's address, the folder to clone into (Browse… in the desktop app; the last one is remembered) and the folder
name, which is filled in from the address. The new repository opens in its own tab when the clone is done. A bar shows the
step git is on (receiving objects, resolving deltas …), an overall percentage and the download speed; it moves forward only
and is the desktop app's (`npm run web` shows a plain moving bar). The address and the folder name are checked first: an
address starting with `-` is refused, so is a name Windows would change (a trailing dot or space, `CON` …), and a folder that
already has files in it is never cloned into or overwritten. Private GitHub repositories use the login Git Credential Manager
holds; if that fails the dialog says to sign in and try again. A running clone cannot be cancelled yet.

**Refreshing when something changes on disk:** the desktop app watches the folder of every open tab and, about a second
after something outside the app changes a repository (a terminal, an editor, a build tool, another Git client), refreshes
the graph, the branches and the changes list. Tabs that are not showing get their badge updated, and it works while the
window is in the background; refreshing when the window regains focus stays as a fallback. A burst of changes is merged
into one refresh (never more than one every 2 s however many files change), and what git itself writes that cannot change
anything shown (objects, lock files) is skipped. So is everything git ignores: the app asks git which folders and files
it ignores (`git ls-files --ignored`) and asks again when `.gitignore` changes, when a new top-level folder appears, and
at most once a minute while changes keep coming. A `build/` or `out/` folder never causes a refresh, whatever it is
called, while a tracked file in a folder called `bin/` does. Until git has answered, and if it cannot, a short list of
well-known generated folders (`node_modules`, `bin`, `obj`, `dist` …) stands in. While the app runs an operation of its
own it does not refresh on top of it; its own reload covers the change, and the watcher's late report of the same change
costs one more quick read (branches and status, not the history). If a watched folder is deleted or moved away the tab
shows as missing (the folder is checked every 5 s), and watching starts again by itself when it comes back. This needs the
desktop app: the browser dev mode (`npm run web`) refreshes on focus only.

**Conflicts:** merge, cherry-pick, revert, pull and "apply stash" stop on conflicts instead of failing. A banner
shows the operation in progress with Continue, Skip (not for merge) and Abort, and the changes panel lists the
conflicted files. Click one to resolve it: tick Ours and/or Theirs for each conflict block (both keeps ours first),
or use "Edit result" to type the final text. "Mark resolved" saves and stages it and moves to the next file.
Whole-file Ours / Theirs, and Keep / Delete for modify-delete conflicts and binary files, are offered where block
merging is not possible. A resolved file can be reopened while the operation is still in progress. A rebase that
was started elsewhere (or by `pull --rebase`) is handled the same way.
