# Undo, editing history and branches

Part of the [GitGui README](../README.md).

**Undo / redo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, plus the toolbar buttons) covers commit, amend, edit commit message,
checkout, create / delete branch, create tag, merge, pull, cherry-pick, revert and reset. Each action is recorded as a
before/after snapshot of HEAD, local branches and tags. Undo is refused if the repository changed outside the
app since, or if it would overwrite local edits. Fetch, push, stash and staging are not undoable.

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

**Force push:** after you rewrite a branch that is already on the remote (a rebase, an amend or an edited commit
message) a normal push is refused, because the remote has commits yours no longer contains (the branch shows `↓1 ↑3`).
When Push is refused for that reason the app opens a check instead of an error: it fetches the remote's copy of the
branch and lists the commits the remote would lose (the first 20, newest first, with their authors). "Force push" then
replaces the remote branch with yours; Cancel leaves everything as it is. The same check is in the right-click menu of
the checked-out branch ("Force push <branch>…", for a branch that has a copy on the remote), and a main branch gets an
extra warning. It is `git push --force-with-lease` pinned to the exact commit that was listed, so if anyone pushes in
the meantime git refuses and nothing is overwritten, even if you fetched in between; it is also refused if your own
branch moved after the check. If the remote branch is already part of yours, or not there, you are told that a normal
push does it. Only the checked-out branch is pushed, and only to the branch of the same name; other branches and tags are
not touched. A force push cannot be undone from the app, and a protected branch can still be refused by the server.

**Deleting branches:** right-click a commit (or a branch in the sidebar) to delete a local branch, its copy on the
remote (`git push --delete`), or both. Deleting the local copy is undoable and git refuses it, with an
"Delete anyway" prompt, if it has unmerged commits; remote deletion always asks first and cannot be undone.
