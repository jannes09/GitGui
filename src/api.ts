type Reply = { ok: true; data: unknown } | { ok: false; error: string };

declare global {
  interface Window {
    gitApi?: {
      call: (method: string, args: object) => Promise<Reply>;
      pickFolder: (title?: string) => Promise<string | null>;
      installUpdate: (folder: string, version: string) => Promise<Reply>;
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
