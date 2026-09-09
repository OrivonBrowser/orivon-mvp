/**
 * Runs `electron-vite build` with the developer-only grant path (src/main/
 * dev-grant.ts, docs/planning/unattended-build-queue.md item 0.3)
 * guaranteed absent, regardless of what ORIVON_ENABLE_DEV_GRANT happens to
 * already be set to in the calling shell.
 *
 * `npm run build` and `npm run package:linux` -- the two commands that
 * produce what actually ships -- go through this rather than a bare
 * `electron-vite build`, so a leftover ambient value (a forgotten export, a
 * stale CI variable) cannot silently carry the dev-grant path into a real
 * build the way a bare `electron-vite build` would: electron.vite.config.ts
 * trusts process.env.ORIVON_ENABLE_DEV_GRANT exactly as it finds it, with no
 * other gate. scripts/check-dev-grant-absent.mjs runs this SAME script
 * (rather than reimplementing the stripping) for its own verification
 * build, so it is proving the exact command a real build runs.
 */
import { spawnSync } from 'node:child_process'

const env = { ...process.env }
delete env.ORIVON_ENABLE_DEV_GRANT

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-vite', 'build'],
  { stdio: 'inherit', env }
)
process.exit(result.status ?? 1)
