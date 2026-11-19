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
