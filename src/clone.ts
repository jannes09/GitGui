// Helpers for the Clone dialog. Pure, so they can be tested (test/clone.test.mjs).

/** The folder name git would pick for a repository address: the last part, without ".git". "" when there is none. */
export function cloneFolderName(url: string): string {
  let u = url.trim().replace(/[\\/]+$/, '');
  u = u.replace(/\.git$/i, '');
  const last = u.split(/[\\/:]/).pop() ?? '';
  return last.replace(/[<>:"|?*\x00-\x1f]/g, '').trim();
}

/** Why this address cannot be cloned, or null when it looks fine. */
export function cloneUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return 'Enter the repository address';
  if (u.startsWith('-')) return 'That is not a repository address';
  if (/[\r\n\0]/.test(u)) return 'That is not a repository address';
  return null;
}

/** Why this folder name cannot be used, or null when it is fine. */
export function cloneNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a folder name';
  if (n === '.' || n === '..' || /[\\/<>:"|?*\x00-\x1f]/.test(n)) return 'The folder name has characters Windows does not allow';
  if (/[. ]$/.test(n)) return 'The folder name cannot end in a dot or space';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return 'Windows reserves that folder name';
  return null;
}
