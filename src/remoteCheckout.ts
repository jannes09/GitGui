// What can be checked out from a commit, and the question asked before a remote branch is checked out over a
// local branch of the same name. Pure, so it can be tested (test/remotecheckout.test.mjs).
import type { RemoteCheckoutInfo } from './types';

export interface CheckoutTarget {
  name: string;
  kind: 'local' | 'remote';
  label: string;
}

/**
 * The branches that can be checked out from a commit: local branches pointing at it (other than the current one),
 * and remote branches pointing at it. A remote branch with no local branch of its name becomes a new local branch.
 * One whose local branch sits on another commit is offered too, since otherwise there is no way to check out where
 * the remote branch is: the app asks whether to reset the local branch to it. If the local branch is on this very
 * commit, it is offered itself and the remote one adds nothing.
 */
export function checkoutTargets(
  branches: { name: string; hash: string; current?: boolean }[],
  remoteBranches: { name: string; hash: string }[],
  hash: string,
): CheckoutTarget[] {
  const locals = branches.filter((b) => b.hash === hash && !b.current).map((b): CheckoutTarget => ({ name: b.name, kind: 'local', label: `Checkout ${b.name}` }));
  const remotes: CheckoutTarget[] = [];
  for (const r of remoteBranches) {
    if (r.hash !== hash) continue;
    const local = r.name.slice(r.name.indexOf('/') + 1);
    const existing = branches.find((b) => b.name === local);
    if (!existing) remotes.push({ name: r.name, kind: 'remote', label: `Checkout ${r.name} (new local branch)` });
    else if (existing.hash !== hash) remotes.push({ name: r.name, kind: 'remote', label: `Checkout ${r.name} (reset local ${local} to here)…` });
  }
  return [...locals, ...remotes];
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

export interface ResetPrompt {
  title: string;
  message: string;
  /** the button that resets the local branch */
  confirm: string;
  /** the button that checks the local branch out as it is; null when it is the branch already checked out */
  keep: string | null;
  /** commits would leave the branch, so the question is a warning */
  danger: boolean;
}

/** The question for a remote branch whose local branch is somewhere else; null when there is nothing to ask. */
export function resetPrompt(info: RemoteCheckoutInfo): ResetPrompt | null {
  if (info.relation === 'none' || info.relation === 'same') return null;
  const { local, remote, ahead, behind } = info;
  const bring = ahead === 1 ? 'it' : 'them';
  let message: string;
  if (info.relation === 'behind') {
    message = `${local} is ${commits(behind)} behind ${remote}. Resetting moves ${local} forward to ${remote} and checks it out. Nothing is lost.`;
  } else if (info.relation === 'ahead') {
    message = `${local} has ${commits(ahead)} that ${remote} does not have. Resetting ${local} to ${remote} takes ${bring} off the branch. Ctrl+Z brings ${bring} back.`;
  } else {
    message =
      `${local} and ${remote} have gone different ways: ${local} has ${commits(ahead)} that ${remote} does not have, ` +
      `and ${remote} has ${commits(behind)} that ${local} does not. Resetting ${local} to ${remote} takes your ${commits(ahead)} off the branch. Ctrl+Z brings ${bring} back.`;
  }
  // a local branch that tracks another remote's branch keeps doing so: say it, since the reset is to a different remote
  if (info.upstream && info.upstream !== remote) message += ` ${local} keeps tracking ${info.upstream}.`;
  return {
    title: `Reset local ${local} to ${remote}?`,
    message,
    confirm: info.current ? `Reset ${local}` : `Reset ${local} and check it out`,
    keep: info.current ? null : `Just check out ${local}`,
    danger: ahead > 0,
  };
}
