# The graph, diffs and settings

Part of the [GitGui README](../README.md).

**Diffs** highlight the exact words that changed inside a modified line. The Up / Down arrows act on whatever has
focus (click it first): in the graph they move the selected commit (PageUp / PageDown / Home / End too); in the
right-hand panel they walk through the changed files (unstaged, then staged, or the files of the selected commit),
opening each diff. The × at the right of a diff closes it (or press Esc).

**Graph:** stashes appear as dashed rows above the commit they were made on (right-click to pop, apply or drop),
branch pills show `↑` / `↓` for unpushed / unpulled commits, and a commit's right-click menu offers checkout and
merge for every branch on it. Double-click a commit that has a branch label to check that branch out. If
uncommitted changes block a checkout you are offered "Stash & checkout". Checking out a remote branch (its commit in the
graph, or the sidebar) creates a local branch that tracks it when there is none. When a local branch of the same name
already exists somewhere else (say `master` is behind `origin/master`), the app asks "Reset local master to origin/master?"
and says how they differ: *Reset … and check it out* moves the local branch to the remote's commit (a warning when it
has commits the remote lacks, which leave the branch but can be brought back with Ctrl+Z), *Just check out master*
switches to the local branch as it is, and Cancel does nothing. This works for every remote branch, not just the main
one, and for branches of a second remote: a local branch that tracks another remote's branch (a fork's `origin/master`
reset to `upstream/master`) keeps tracking it, so a later push does not start going somewhere else, and the prompt says
so. Text in graph rows cannot be selected, so the
double-click that checks out a branch never also highlights a word of its pill; the commit message in the details panel
can still be selected and copied. Everything that can be clicked (buttons, graph rows, sidebar items, file rows, repository
tabs, the switches in Settings, the Amend checkbox) shows a pointer cursor and a hover highlight; `test/hover.test.mjs`
checks this against the components, so a new clickable element cannot skip it. Disabled buttons keep the arrow.

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
   feature branches never push aside (a branch cut from its newest commit joins it instead of taking its place). The
   uncommitted-changes (WIP) circle sits straight above the tip of that line when that commit is checked out; with
   another commit or branch checked out it keeps a lane of its own.
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

**Resizable panels:** drag the dividers beside the sidebar and the details panel, or the edge of the
BRANCH / TAG column header. Double-click resets, arrow keys nudge, and widths are remembered.
