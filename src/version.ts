// Filled in by Vite from package.json when the UI is built (see vite.config.ts).
declare const __APP_VERSION__: string;

/** The version of the app this UI belongs to, e.g. "0.2.0". */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
