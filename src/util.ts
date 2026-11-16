export function relativeDate(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'min'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let value = diff / 60;
  let label = 'min';
  for (let i = 0; i < units.length; i++) {
    const [size, name] = units[i];
    if (diff >= size) {
      value = diff / size;
      label = name;
    }
  }
  const n = Math.floor(value);
  return `${n} ${label}${n === 1 ? '' : 's'} ago`;
}

export function fullDate(unixSecondsOrIso: number | string): string {
  const d = typeof unixSecondsOrIso === 'number' ? new Date(unixSecondsOrIso * 1000) : new Date(unixSecondsOrIso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i + 1) : '';
}

export function shortHash(h: string): string {
  return h.slice(0, 7);
}

export function parseTrack(track: string): { ahead: number; behind: number } {
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}
