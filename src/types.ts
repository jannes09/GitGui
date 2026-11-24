export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number; // unix seconds
  refsRaw: string;
  subject: string;
  /** set on rows that represent a stash (e.g. "stash@{0}") rather than a real history commit */
  stashRef?: string;
}

export interface LocalBranch {
  name: string;
  hash: string;
  current: boolean;
  upstream: string | null;
  track: string;
}
export interface RemoteBranch {
  name: string;
  hash: string;
  remote: string;
}
export interface TagRef {
  name: string;
  hash: string;
}
export interface Stash {
  ref: string;
  hash: string;
  message: string;
  date: number;
  /** the commit the stash was made on */
  parent: string | null;
}
export interface RefsData {
  head: string | null;
  current: string | null;
  remotes: string[];
  branches: LocalBranch[];
  remoteBranches: RemoteBranch[];
  tags: TagRef[];
  stashes: Stash[];
}

export interface StatusFile {
  path: string;
  index: string;
  worktree: string;
  orig?: string;
  untracked?: boolean;
  conflicted?: boolean;
}
export interface Operation {
  kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase';
  detail: string;
}
export interface StatusData {
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
  /** a merge, cherry-pick, revert or rebase that stopped and is waiting for the user */
  operation: Operation | null;
  /** files that were conflicted and have been resolved since (they can be reopened) */
  resolved: string[];
}

export interface CommitFile {
  status: string;
  path: string;
  orig?: string;
  /** the commit whose diff shows this file, when it is not the selected one (a stash's untracked files) */
  ref?: string;
}
export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface AccountProfile {
  username: string;
  name: string;
  email: string;
}
export interface GcmStatus {
  available: boolean;
  version: string | null;
  /** GitHub accounts Git Credential Manager is currently signed in to */
  accounts: string[];
}
export interface AccountsData {
  profiles: AccountProfile[];
  gcm: GcmStatus;
  /** the global git identity, offered when adding a first account */
  suggestion: { name: string; email: string };
}
export interface ActiveAccount {
  username: string | null;
  scope: 'local' | 'global' | null;
  name: string;
  email: string;
  remotes: { count: number; githubHttps: boolean; githubSsh: boolean };
}

/** The unpushed commits whose message may be edited; `reason` says why none can be, when that is so for the whole repository. */
export interface EditableCommits {
  hashes: string[];
  reason: string | null;
}

/** A commit's message split for editing, and what saving it will involve. */
export interface CommitEditInfo {
  summary: string;
  description: string;
  /** commits after it on the branch that get new ids */
  later: number;
  branch: string | null;
}

export interface RewordResult {
  /** the edited commit's new id */
  hash: string;
  /** every rebuilt commit: old id to new id */
  map: Record<string, string>;
}

/** What the update folder holds, compared with the running app. `error` is set when it could not be read. */
export interface UpdateInfo {
  current: string;
  /** the folder that was looked in; null when none is set and there is no default */
  folder: string | null;
  /** the version of the installer in the folder */
  latest: string | null;
  available: boolean;
  size: number | null;
  /** ISO time the installer was built */
  releaseDate: string | null;
  error: string | null;
}

/** How a remote branch relates to the local branch of the same name, asked before the remote branch is checked out. */
export interface RemoteCheckoutInfo {
  /** the local branch of the same name, which may not exist yet */
  local: string;
  remote: string;
  localHash: string | null;
  remoteHash: string;
  /** commits only the local branch has / only the remote one has */
  ahead: number;
  behind: number;
  /** none = no local branch yet, same = both on one commit */
  relation: 'none' | 'same' | 'behind' | 'ahead' | 'diverged';
  /** the local branch is the one that is checked out */
  current: boolean;
  /** the remote branch the local branch tracks now (null when it tracks nothing or does not exist) */
  upstream: string | null;
}

/** A commit of the remote's that a force push would drop. */
export interface ForcePushCommit {
  hash: string;
  author: string;
  /** unix seconds */
  date: number;
  subject: string;
}

/** The remote's copy of the checked-out branch compared with the local one, for the force push confirmation. */
export interface ForcePushInfo {
  branch: string;
  remote: string;
  /** the local commit that would be pushed */
  head: string;
  /** the commit the remote branch is at now (what the push is pinned to); null when it is not on the remote */
  remoteTip: string | null;
  /** gone = not on the remote, same, ahead = only a normal push is needed, behind / diverged = forcing replaces commits */
  relation: 'gone' | 'same' | 'ahead' | 'behind' | 'diverged';
  /** the commits only the remote has (newest first, the first few) */
  lost: ForcePushCommit[];
  lostTotal: number;
  /** the commits only the local branch has */
  localOnly: number;
}

export interface RepoSnapshot {
  head: { branch: string | null; hash: string | null };
  branches: Record<string, string>;
  tags: Record<string, string>;
}
export interface UndoOp {
  label: string;
  before: RepoSnapshot;
  after: RepoSnapshot;
  mode: 'soft' | 'keep';
  /** commits this step rebuilt under new ids (old to new), so the selection can follow them through undo and redo */
  remap?: Record<string, string>;
}

export type Selection = { kind: 'wip' } | { kind: 'commit'; hash: string } | { kind: 'stash'; hash: string } | null;

export interface DiffTarget {
  path: string;
  staged?: boolean;
  untracked?: boolean;
  hash?: string;
  /** open the conflict resolver instead of a diff */
  conflict?: boolean;
}

/** What the resolver needs to know about one conflicted file. */
export interface ConflictFileInfo {
  path: string;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
  /** the file exists in the working tree */
  exists: boolean;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** not valid UTF-8, so editing it here could damage it */
  lossy: boolean;
}

/** Returned by actions that can stop on conflicts instead of failing. */
export interface ConflictOutcome {
  conflicts: boolean;
  files?: number;
  stashKept?: boolean;
  fastForward?: boolean;
  upToDate?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  /** the pull request's page, built by the backend from the repository's address */
  url: string;
  /** the branch the pull request comes from */
  branch: string;
  target: string;
  author: string;
  draft: boolean;
  /** comes from someone's fork, so its branch name is not one of this repository's branches */
  fork: boolean;
}
/** Where the repository's pages live, read from the remote's address alone (no network); provider is null for other hosts. */
export interface RemoteWeb {
  provider: 'github' | 'azure' | null;
  remote?: string;
  name?: string;
  webUrl?: string;
  listUrl?: string;
}

/** Open pull requests of the repository's GitHub / Azure DevOps remote; provider is null for other hosts. */
export interface PullRequestInfo {
  provider: 'github' | 'azure' | null;
  remote?: string;
  name?: string;
  webUrl?: string;
  listUrl?: string;
  prs: PullRequest[];
  error?: string | null;
  authenticated?: boolean;
}
