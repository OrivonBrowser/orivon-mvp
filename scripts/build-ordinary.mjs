/**
 * Runs `electron-vite build` with the developer-only grant path (src/main/
 * dev-grant.ts, .claude/unattended-build-queue.md item 0.3)
 * guaranteed absent, regardless of what ORIVON_ENABLE_DEV_GRANT happens to
 * already be set to in the calling shell.
 *
 * `npm run build`, `npm run package:linux` and `npm start` -- every command
 * that produces or launches what actually ships -- go through this rather
 * than a bare `electron-vite build`, so a leftover ambient value (a
 * forgotten export, a stale CI variable) cannot silently carry the
 * dev-grant path into a real build the way a bare `electron-vite build`
 * would: electron.vite.config.ts trusts process.env.ORIVON_ENABLE_DEV_GRANT
 * exactly as it finds it, with no other gate. `npm start` runs this script
 * and then `electron-vite preview --skipBuild`: `electron-vite preview`
 * alone rebuilds from the ambient env on its own, bypassing this script
 * entirely, which is exactly the gap `--skipBuild` closes. scripts/
 * check-dev-grant-absent.mjs runs this SAME script (rather than
 * reimplementing the stripping) for its own verification build, so it is
 * proving the exact command a real build runs.
 */
import { spawnCommandSync } from './cli.mjs'

const env = { ...process.env }
delete env.ORIVON_ENABLE_DEV_GRANT

const result = spawnCommandSync(
  'npx',
  ['electron-vite', 'build'],
  { env }
)
process.exit(result.status ?? 1)
