// Profile pictures for commit authors. This file is the logic only (no React) so it can be tested;
// src/components/AuthorPicture.tsx draws the pictures. Covered by test/avatars.test.mjs.
//
// Where a picture can come from, and what each source is sent:
//   GitHub    github.com/<username>.png. Only a public username goes out. The username is read from a GitHub
//             "no-reply" address (12345+name@users.noreply.github.com) or from a saved account whose email matches.
//   Gravatar  gravatar.com/avatar/<hash>. A SHA-256 hash of the author's email address goes out, so it is a
//             separate setting that is off until it is switched on.

export interface PictureSources {
  /** use GitHub pictures */
  github: boolean;
  /** also look authors up on Gravatar */
  gravatar: boolean;
  /** saved GitHub accounts: their own commits get their picture whatever address they were made with */
  accounts: { username: string; email: string }[];
}

export const NO_SOURCES: PictureSources = { github: false, gravatar: false, accounts: [] };

/** Pixels requested: sharp enough for a 28 px avatar on a high-density screen, and one size so pictures are shared. */
export const PICTURE_PX = 64;

const NOREPLY_RE = /^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]{0,38}))@users\.noreply\.github\.com$/;
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function cleanEmail(email: string | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e.length > 3 && e.length <= 254 && e.includes('@') ? e : null;
}

/** The GitHub username behind an author's email, when it can be told without asking anyone. */
export function githubUsername(email: string | undefined, accounts: PictureSources['accounts']): string | null {
  const e = cleanEmail(email);
  if (!e) return null;
  const noreply = NOREPLY_RE.exec(e);
  if (noreply) return noreply[1];
  const account = accounts.find((a) => USERNAME_RE.test(a.username) && cleanEmail(a.email) === e);
  return account ? account.username : null;
}

/** Gravatar's address for an email: the SHA-256 of the trimmed, lower-cased address. */
export async function gravatarHash(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The addresses worth trying for an author, best first. Nothing is fetched here. */
export async function pictureUrls(email: string | undefined, sources: PictureSources): Promise<string[]> {
  const e = cleanEmail(email);
  if (!e) return [];
  const urls: string[] = [];
  if (sources.github) {
    const user = githubUsername(e, sources.accounts);
    if (user) urls.push(`https://github.com/${user}.png?size=${PICTURE_PX}`);
  }
  if (sources.gravatar) {
    try {
      urls.push(`https://gravatar.com/avatar/${await gravatarHash(e)}?s=${PICTURE_PX}&d=404`); // 404 when there is none, so initials show
    } catch {
      /* no crypto in this context: skip Gravatar */
    }
  }
  return urls;
}

/** True when the address loads as an image. */
export type Probe = (url: string) => Promise<boolean>;

const imageProbe: Probe = (url) =>
  new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

/** The first picture that loads, or null. */
export async function findPicture(email: string | undefined, sources: PictureSources, probe: Probe = imageProbe): Promise<string | null> {
  for (const url of await pictureUrls(email, sources)) if (await probe(url)) return url;
  return null;
}

/* ---------- remembering what was found ---------- */

/** A miss is not final: the network may have been down, so it is looked at again after a while. */
export const MISS_TTL_MS = 5 * 60 * 1000;
/** Pictures fetched at once, so a screenful of new authors does not open dozens of connections. */
export const MAX_PROBES = 6;

interface Entry {
  url: string | null;
  at: number;
}
const known = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
let running = 0;
const queue: (() => void)[] = [];

/** One entry per author and set of sources, so changing a setting looks everyone up again. */
export function pictureKey(email: string | undefined, sources: PictureSources): string | null {
  const e = cleanEmail(email);
  if (!e || (!sources.github && !sources.gravatar)) return null;
  const user = sources.github ? githubUsername(e, sources.accounts) : null;
  return `${sources.github ? 'g' : '-'}${sources.gravatar ? 'v' : '-'}|${user ?? ''}|${e}`;
}

/** What is already known: a picture's address, null for none, undefined when nobody has looked yet (or the miss is old). */
export function peekPicture(email: string | undefined, sources: PictureSources, now = Date.now()): string | null | undefined {
  const key = pictureKey(email, sources);
  if (!key) return null;
  const hit = known.get(key);
  if (!hit) return undefined;
  return hit.url === null && now - hit.at > MISS_TTL_MS ? undefined : hit.url;
}

/** Looks an author up (once, however many rows ask at the same time) and remembers the answer. */
export function loadPicture(email: string | undefined, sources: PictureSources, probe: Probe = imageProbe): Promise<string | null> {
  const key = pictureKey(email, sources);
  if (!key) return Promise.resolve(null);
  const have = peekPicture(email, sources);
  if (have !== undefined) return Promise.resolve(have);
  const pending = inflight.get(key);
  if (pending) return pending;

  const limited: Probe = async (url) => {
    if (running >= MAX_PROBES) await new Promise<void>((go) => queue.push(go));
    running++;
    try {
      return await probe(url);
    } finally {
      running--;
      queue.shift()?.();
    }
  };
  const job = findPicture(email, sources, limited)
    .then((url) => {
      known.set(key, { url, at: Date.now() });
      return url;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** For tests. */
export function forgetPictures(): void {
  known.clear();
  inflight.clear();
}
