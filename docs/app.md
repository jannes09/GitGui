# The app: icon, installer and updates

Part of the [GitGui README](../README.md).

**Icon and splash:** the app icon is a white commit graph on a bright teal-to-blue tile, drawn at every size from the
vector (the small sizes use heavier lines) so it stays visible on a taskbar; `npm run icon` redraws it. On start a
small splash window shows a commit graph drawing itself (one branch leaves the main line and merges back) for at least
1.8 s while the main window loads, then fades out. The app's version number appears under the name. It is
`electron/splash.html`, pure CSS (the main process writes the version into it before loading, see `electron/splash-page.cjs`),
and follows the system's reduced-motion setting. `GITGUI_SPLASH_LOG=1` prints the splash timing and quits, for checking
the sequence.

**Version number:** shown on the splash and next to the title of the Settings dialog (`GitGui 0.2.0`). It is the
`version` in `package.json`, so raising it there (see Updates below) changes both after the next build.

**Portable exe or installer:** the portable exe unpacks the whole app (about 315 MB) into a temp folder every time it
starts, which takes around 9 s before the splash can appear. The installer (`npm run dist:installer`, per-user, no
admin rights needed) unpacks once, so the splash shows within half a second. Use the installer for daily use and pin the
installed shortcut; the portable exe is for carrying the app around.

**Desktop shortcut is optional:** the installer's wizard has an "Additional tasks" page after the installation folder with
"Create a desktop shortcut", **unticked** on a fresh install (the Start menu shortcut is always made). Running Setup again
to update starts the box **ticked** when a desktop shortcut already exists, so an update does not take away a shortcut you
have; untick it to drop the shortcut. A silent install (`/S`) follows the same default. electron-builder is told not to make
the shortcut itself (`nsis.createDesktopShortcut: false`) and `build/installer.nsh` adds the page, creates the shortcut when
chosen and removes it on uninstall. `test/installer.test.cjs` compiles that script into a stand-in installer with the NSIS
electron-builder downloads and runs its cases (Windows only, skipped when that NSIS is not there); it uses a shortcut name of
its own, so your real GitGui shortcut is never touched.

**Updates from a local folder:** when GitGui starts it looks in a folder on this computer for a newer build and, if there
is one, asks whether to install it (Install and restart, Later, or Skip this version). Nothing is downloaded and nothing
leaves the computer. The folder is the one `npm run dist` / `dist:installer` write to (`release/`); the build records
that path, so it works without any setup, and Settings → Updates can point it somewhere else, switch the start-up
check off, check right now (that ignores a skipped version) or ask about a skipped version again. It reads `latest.yml`
and the `GitGui-Setup-<version>.exe` it names, and a build counts as newer only when its version number is higher than
the running app's, so raise `version` in `package.json` (for example `npm version minor --no-git-tag-version`) before
building a release. Before the installer is started it is checked against the SHA-512 in `latest.yml`, so a damaged or
half-written file is refused. Installing starts the installer and closes GitGui; the installer keeps your settings and
repositories and offers to start the new version when it is done. The portable exe and a source checkout cannot be
replaced in place, so for them the installer is only shown in its folder.
