/**
 * Runs `electron-vite build` with the developer-only grant path compiled in
 * (docs/planning/unattended-build-queue.md item 0.3, src/main/dev-grant.ts).
 * `npm run test:e2e`'s only build step -- `npm run build`, `npm run smoke`
 * and `npm run package:linux` all go through scripts/build-ordinary.mjs
 * instead, which strips this flag even if the calling shell already had it
 * exported, so an ordinary or packaged build never carries the path
 * (scripts/check-dev-grant-absent.mjs proves it against the compiled
 * output, not just this file's intent).
 *
 * A plain `ORIVON_ENABLE_DEV_GRANT=1 electron-vite build` in package.json
 * would be simpler, but that shell syntax is not portable to Windows'
 * cmd.exe, a supported run-from-source platform (Rule 8) -- and this repo
 * has no dependency like cross-env to paper over that (Rule 8's sibling
 * constraint: zero runtime dependencies). A plain Node script is portable
 * without adding one.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-vite', 'build'],
  { stdio: 'inherit', env: { ...process.env, ORIVON_ENABLE_DEV_GRANT: '1' } }
)
process.exit(result.status ?? 1)
