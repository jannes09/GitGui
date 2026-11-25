# GitHub accounts and pull requests

Part of the [GitGui README](../README.md).

**GitHub accounts:** the toolbar's account button (profile picture and username) switches which saved account the
repository uses. A switch sets the repository's `user.name`, `user.email` and
`credential.https://github.com.username`, so Git Credential Manager uses that account for fetch / pull / push, and a
small dot shows whether it is signed in. "Manage accounts" adds, edits and removes accounts, signs in or out (via
Git Credential Manager's browser flow) and can set a default for all repositories. If a fetch, pull or push fails
because you are signed out or on the wrong account, the app offers to sign in and retries. Profile pictures are
loaded from `github.com/<username>.png` (only the public username is sent) and fall back to initials. Account
details (username, name, email — never passwords or tokens) are kept in `~/.gitgui/accounts.json`.
Only github.com over HTTPS is affected; SSH remotes just get the commit identity.

**Pull requests:** for repositories on GitHub or Azure DevOps (https or ssh remotes) the app looks up the open pull
requests and shows `#12` on the branch's pill in the graph and in the sidebar (click it to open the pull request in
your browser). The toolbar gets a shortcut: `PR #12` for the current branch's pull request, `Create PR` for a pushed
branch that has none, or `PRs` for the repository's list. Right-click a branch for "Open pull request…" /
"Create pull request…". Drafts are dimmed and pull requests from forks are ignored. Lookups are read only and use the
login Git Credential Manager already holds for that host (asked for without any prompt, kept in memory for two
minutes, sent only to `api.github.com` / `dev.azure.com`); without a login only public repositories work. They run
when a repository opens, after Fetch, and when the window regains focus (at most every 20 s with a login, 2 min
without). Other hosts simply show no badges.

**The pull request a commit was merged by:** a commit whose message says it came in through a pull request ("Merge pull
request #6 from user/branch" or a squash merge's "Title (#6)" on GitHub, "Merged PR 6: Title" on Azure DevOps) gets a
"Pull request #6" button in the commit details, under the hashes, and "Open pull request #6…" in its right-click menu.
Both open the pull request's page in your browser. The address is worked out from the remote's URL alone, so this needs no
login or network and still works with the pull request lookups switched off.

**Author pictures:** the round avatar on a commit in the graph, and the one in the commit details, show the author's
profile picture when one can be found, and their initials otherwise. A picture is found without asking anyone for an
email address in two cases: the author committed with a GitHub no-reply address (`12345+name@users.noreply.github.com`,
what GitHub uses when you keep your email private), or the address is the one of a saved account (so your own commits
show your picture whatever address they were made with). Only the public username is sent, to `github.com`. Looking
other authors up on Gravatar is a separate switch in Settings → Profile pictures and is **off** by default, because it
sends a SHA-256 hash of each author's email address to `gravatar.com`. Pictures are fetched a few at a time, once per
author, and a lookup that found nothing is repeated after five minutes (the network may have been down). With both
switches off nothing is requested. Merge commits, WIP and stash rows have no avatar. Pictures from other hosts (for
example Azure DevOps profiles, which need a sign-in) are not supported.
