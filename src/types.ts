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
export interface StatusData {
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
}

export interface CommitFile {
  status: string;
  path: string;
  orig?: string;
}
export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  message: string;
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
}
