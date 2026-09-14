/**
 * `npm run dev`, with ORIVON_WINDOW_NO_FOCUS=1 set (docs/development/setup.md
 * "The no-focus switch") so a dev-server launch does not steal the owner's
 * keyboard focus while they are working on something else.
 *
 * A plain `ORIVON_WINDOW_NO_FOCUS=1 electron-vite dev` in package.json would
 * be simpler, but that shell syntax is not portable to Windows' cmd.exe, a
 * supported run-from-source platform (Rule 8) -- same reasoning as
 * build-e2e.mjs's own ORIVON_ENABLE_DEV_GRANT, ported here. `electron-vite`
 * is resolved via node_modules/.bin (already on PATH from `npm run dev`
 * itself), not via npx -- npm's own .cmd shim needs its exact name on
 * Windows, same as npx.cmd elsewhere in this repo.
 */
import { spawnSync } from 'node:child_process'

const command = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
const result = spawnSync(command, ['dev'], {
  stdio: 'inherit',
  env: { ...process.env, ORIVON_WINDOW_NO_FOCUS: '1' }
})
process.exit(result.status ?? 1)
