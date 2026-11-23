// Links to a repository's pull request pages. Pure functions, covered by test/prlinks.test.mjs.

import type { PullRequestInfo } from './types';

/** The page for starting a pull request from `branch`. */
export function createPrUrl(info: Pick<PullRequestInfo, 'provider' | 'webUrl'>, branch: string): string | null {
  if (!info.webUrl || !info.provider) return null;
  if (info.provider === 'github') return `${info.webUrl}/pull/new/${branch.split('/').map(encodeURIComponent).join('/')}`;
  return `${info.webUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`;
}

/**
 * The number of the pull request a commit was merged by, read from its subject. GitHub: "Merge pull request #12 from
 * user/branch", and a squash or rebase merge's "Title (#12)". Azure DevOps: "Merged PR 12: Title". null for anything else.
 */
export function mergedPrNumber(subject: string | undefined, provider: 'github' | 'azure' | null | undefined): number | null {
  if (!subject || !provider) return null;
  const m =
    provider === 'github'
      ? /^Merge pull request #(\d{1,9})\b/.exec(subject) ?? /\(#(\d{1,9})\)\s*$/.exec(subject)
      : /^Merged PR (\d{1,9}):/.exec(subject);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

/** The page of pull request `number` on the repository's provider, or null for a host we do not know. */
export function pullRequestUrl(info: Pick<PullRequestInfo, 'provider' | 'webUrl'>, number: number): string | null {
  if (!info.webUrl || !info.provider || !Number.isSafeInteger(number) || number < 1) return null;
  return info.provider === 'github' ? `${info.webUrl}/pull/${number}` : `${info.webUrl}/pullrequest/${number}`;
}

/** Only ever open pages on the providers we talk to, whatever the data says. */
export function isSafePrUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'dev.azure.com' || u.hostname.endsWith('.visualstudio.com'));
  } catch {
    return false;
  }
}

/** The branch a local branch is published as: its upstream's name, or its own when it has none. */
export function publishedName(local: string, upstream: string | null | undefined): string {
  return upstream ? upstream.slice(upstream.indexOf('/') + 1) : local;
}
