// User settings, kept in localStorage. Covered by test/settings.test.mjs.

/** The branches people look for first: the ones everything else is merged into or released from. */
export const DEFAULT_MAIN_BRANCHES = 'main, master, dev, develop, development, trunk, staging, production, release, release/*';

export interface Settings {
  /** 1. main lanes are drawn thicker, with bigger commit dots */
  laneBold: boolean;
  /** 2. the main branch always sits in the first lane, on the far left */
  lanePin: boolean;
  /** 3. a soft tinted band runs behind the main lanes */
  laneBand: boolean;
  /** 3. commit messages on the main line are shown in bold */
  boldMessages: boolean;
  /** 4. main branches always use the same colour (dev teal, main / master gold, others purple) */
  fixedColors: boolean;
  /** 4. a branch name chip stays at the top of each main lane while you scroll */
  laneChips: boolean;
  /** look up open pull requests on GitHub / Azure DevOps */
  prLookups: boolean;
  /** show GitHub profile pictures for authors with a GitHub address or a saved account (only a public username is sent) */
  profilePictures: boolean;
  /** also look authors up on Gravatar, which sends a hash of each author's email address to gravatar.com */
  gravatarLookups: boolean;
  /** which branches count as main branches: names separated by commas, `*` as a wildcard */
  mainBranches: string;
  /** when the app starts, look in the update folder for a newer build and offer it */
  updateCheck: boolean;
  /** the folder holding latest.yml and the installer; empty means the release folder this build was made in */
  updateFolder: string;
  /** a version the user chose not to be asked about again at start-up */
  skippedUpdate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  laneBold: true,
  lanePin: true,
  laneBand: true,
  boldMessages: true,
  fixedColors: true,
  laneChips: true,
  prLookups: true,
  profilePictures: true,
  gravatarLookups: false, // off until switched on: it tells a third party which email addresses appear in the history
  mainBranches: DEFAULT_MAIN_BRANCHES,
  updateCheck: true,
  updateFolder: '',
  skippedUpdate: '',
};

export const SETTINGS_KEY = 'gitgui.settings';
/** longest accepted value of each text setting */
const MAX_TEXT: Partial<Record<keyof Settings, number>> = { mainBranches: 400, updateFolder: 400, skippedUpdate: 20 };

/** Reads stored settings, ignoring anything that is not the right type so a hand-edited value cannot break the app. */
export function parseSettings(raw: string | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const limit = MAX_TEXT[key];
    if (limit !== undefined) {
      if (typeof o[key] === 'string') (out[key] as string) = (o[key] as string).slice(0, limit);
    } else if (typeof o[key] === 'boolean') {
      (out[key] as boolean) = o[key] as boolean;
    }
  }
  return out;
}

export function readSettings(): Settings {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage can be unavailable; settings then last until the window closes */
  }
}
