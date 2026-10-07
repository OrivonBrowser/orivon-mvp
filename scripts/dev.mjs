/**
 * `npm run dev`. It sets ORIVON_WINDOW_NO_FOCUS=1, so a dev launch does not
 * steal keyboard focus (docs/development/setup.md "The no-focus switch"), and
 * ORIVON_DEV_ORIGINS=1, developer mode (src/main/dev/dev-mode.ts): `.eth`
 * names and Inspect Element. Only this script sets it, never `npm start`.
 *
 * Every launch runs on a fresh profile (scripts/dev-profile.mjs), so a dev
 * launch never touches or hands over to the profile `npm start` and a packaged
 * build use (setup.md "The dev profile"). ORIVON_INTRO is `always`, or `off` under
 * --skip-intro (setup.md "The welcome screen"); every other argument after
 * `npm run dev --` goes to Electron.
 *
 * NO `--watch`, deliberately: a main-process or preload edit does NOT appear
 * until `npm run dev` is restarted, and a half-applied change (renderer
 * hot-reloaded, main stale) looks like a bug in the feature -- restart before
 * believing it. Why, in setup.md.
 *
 * A script, not `VAR=1 electron-vite dev` in package.json: that syntax fails in
 * Windows' cmd.exe (Rule 8). `electron-vite` comes from node_modules/.bin, on
 * PATH under npm, not npx; scripts/cli.mjs's `spawnCommandSync` is what makes
 * its .cmd shim launchable on Windows.
 */
import { spawnCommandSync } from './cli.mjs'
import { fetchBundledExtensions } from './fetch-bundled-extensions.mjs'
import { devSwitches, makeDevProfile, removeWhenDone, sweepDevProfiles } from './dev-profile.mjs'

const passed = process.argv.slice(2)
const skipIntro = passed.includes('--skip-intro') || process.env.npm_config_skip_intro === 'true'
const intro = skipIntro ? 'off' : process.env.ORIVON_INTRO ?? 'always'
sweepDevProfiles()
// A new dev profile installs the bundled extensions (src/main/default-profile/); a failed fetch costs only that.
for (const failure of await fetchBundledExtensions()) console.error(`[dev] ${failure}`)
const { switches, profile } = devSwitches(passed, () => makeDevProfile())
if (profile !== null) console.error(`[dev] fresh profile for this launch: ${profile}`)

// Ctrl+C, or a closed terminal, reaches electron-vite and Electron on its own; this process outlives them to delete the profile.
for (const signal of ['SIGINT', 'SIGHUP']) process.on(signal, () => {})
const result = spawnCommandSync('electron-vite', ['dev', '--', ...switches], {
  env: { ...process.env, ORIVON_WINDOW_NO_FOCUS: '1', ORIVON_DEV_ORIGINS: '1', ORIVON_INTRO: intro }
})
if (profile !== null && !removeWhenDone(profile)) {
  console.error(`[dev] kept ${profile}: a browser opened from this launch still runs on it. The next npm run dev deletes it`)
}
process.exit(result.status ?? 1)
