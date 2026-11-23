// The words of the force push confirmation, kept apart from the UI so they can be tested.
// Covered by test/forcepush.test.mjs.
import type { ForcePushInfo } from './types';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** When forcing is not what is needed, a sentence saying so; null when the remote branch really would be replaced. */
export function forcePushNotice(info: ForcePushInfo): string | null {
  const where = `${info.remote}/${info.branch}`;
  switch (info.relation) {
    case 'gone':
      return `${where} is not on the remote, so a normal push does it. Use Push.`;
    case 'same':
      return `${where} already matches your branch. There is nothing to push.`;
    case 'ahead':
      return `${where} is already part of your branch, so a normal push does it. Use Push.`;
    default:
      return null;
  }
}

export interface ForcePushText {
  title: string;
  message: string;
  detail: string;
  note: string;
  confirm: string;
}

/** What to show before replacing the remote branch: the commits it would lose, and what that means. */
export function forcePushText(info: ForcePushInfo, mainBranch: boolean): ForcePushText {
  const where = `${info.remote}/${info.branch}`;
  const lines = info.lost.map((c) => `${c.hash.slice(0, 7)}  ${shorten(c.subject, 64)}  (${c.author})`);
  const more = info.lostTotal - info.lost.length;
  if (more > 0) lines.push(`…and ${more} more`);

  const warning = mainBranch ? `${info.branch} is one of your main branches, so everyone who uses it will be affected.\n\n` : '';
  const what = info.localOnly > 0 ? `Your branch, with ${count(info.localOnly, 'commit')} the remote does not have, takes their place.` : `Your branch is behind the remote one, so the remote moves back to your older commit.`;
  const note =
    `${what}\n\n` +
    'Use this after you rewrote the branch (rebase, amend, edited message). If someone else added commits, cancel and pull first, or their work is lost from the remote.\n\n' +
    `It only goes through if ${where} is still exactly as listed: if anyone pushes in the meantime, nothing is overwritten.`;

  return {
    title: `Replace ${where}?`,
    message: `${warning}${where} has ${count(info.lostTotal, 'commit')} that ${info.lostTotal === 1 ? 'is' : 'are'} not in your branch. Force pushing drops ${info.lostTotal === 1 ? 'it' : 'them'} from the remote:`,
    detail: lines.join('\n'),
    note,
    confirm: 'Force push',
  };
}
