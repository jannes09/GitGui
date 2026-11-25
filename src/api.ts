type Reply = { ok: true; data: unknown } | { ok: false; error: string };

/** Progress of a long running call (a clone): the step git is on, the overall 0-100 and e.g. the download speed. */
export interface Progress {
  step: string;
  percent: number;
  detail: string;
}

declare global {
  interface Window {
    gitApi?: {
      call: (method: string, args: object) => Promise<Reply>;
      pickFolder: (title?: string) => Promise<string | null>;
      installUpdate: (folder: string, version: string) => Promise<Reply>;
      watchRepos?: (roots: string[]) => Promise<boolean>;
      onRepoChanged?: (cb: (root: string) => void) => () => void;
      onProgress?: (cb: (method: string, p: Progress) => void) => () => void;
    };
  }
}

export const isElectron = typeof window !== 'undefined' && !!window.gitApi;

/** Calls a git backend method (IPC in Electron, /rpc in a plain browser). */
export async function call<T = void>(method: string, args: object = {}): Promise<T> {
  let reply: Reply;
  if (window.gitApi) {
    reply = await window.gitApi.call(method, args);
  } else {
    const res = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    });
    reply = await res.json();
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}

export async function pickFolder(title?: string): Promise<string | null> {
  return window.gitApi ? window.gitApi.pickFolder(title) : null;
}

/** Asks the desktop app to watch these repositories for changes on disk (none in a plain browser). */
export function watchRepos(roots: string[]): void {
  void window.gitApi?.watchRepos?.(roots).catch(() => {});
}

/** Calls `cb` with the progress of `method` while it runs (desktop app only). Returns the function that stops listening. */
export function onProgress(method: string, cb: (p: Progress) => void): () => void {
  return window.gitApi?.onProgress?.((m, p) => m === method && cb(p)) ?? (() => {});
}

/** Calls `cb` with a repository's root when it changed on disk. Returns the function that stops listening. */
export function onRepoChanged(cb: (root: string) => void): () => void {
  return window.gitApi?.onRepoChanged?.(cb) ?? (() => {});
}

/**
 * Starts the installer of the newer build in the update folder and closes the app so it can be replaced.
 * `launched` is false when the installer was only shown in its folder (portable exe, or running from source).
 */
export async function installUpdate(folder: string, version: string): Promise<{ launched: boolean }> {
  if (!window.gitApi) throw new Error('Installing an update only works in the desktop app, not in a browser.');
  const reply = await window.gitApi.installUpdate(folder, version);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as { launched: boolean };
}
