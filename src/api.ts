type Reply = { ok: true; data: unknown } | { ok: false; error: string };

declare global {
  interface Window {
    gitApi?: {
      call: (method: string, args: object) => Promise<Reply>;
      pickFolder: () => Promise<string | null>;
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

export async function pickFolder(): Promise<string | null> {
  return window.gitApi ? window.gitApi.pickFolder() : null;
}
