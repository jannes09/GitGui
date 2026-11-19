// Links to a repository's pull request pages. Pure functions, covered by test/prlinks.test.mjs.

import type { PullRequestInfo } from './types';

/** The page for starting a pull request from `branch`. */
export function createPrUrl(info: Pick<PullRequestInfo, 'provider' | 'webUrl'>, branch: string): string | null {
  if (!info.webUrl || !info.provider) return null;
  if (info.provider === 'github') return `${info.webUrl}/pull/new/${branch.split('/').map(encodeURIComponent).join('/')}`;
  return `${info.webUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`;
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
