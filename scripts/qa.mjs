/**
 * `npm run qa` and `npm run qa:visual`: build the e2e bundle, run the QA
 * specs headless with pixel comparison on, then write the inspection sheet
 * whether or not the specs passed. A failed build stops before any of that, so
 * the sheet never describes an earlier run. The exit code is the specs'. Extra
 * arguments go to vitest (for example `-t "<test name>"`).
 */
import { spawnSync } from 'node:child_process'
import { isInvokedDirectly } from './cli.mjs'

export const QA_SPECS = ['test/qa-visual.test.ts', 'test/qa-evidence.test.ts', 'test/e2e-qa-audit.test.ts', 'test/e2e-qa-visual.test.ts', 'test/e2e-qa-evidence.test.ts', 'test/e2e-qa-journey.test.ts', 'test/e2e-qa-adversarial.test.ts']
export const VISUAL_SPECS = ['test/qa-visual.test.ts', 'test/e2e-qa-audit.test.ts', 'test/e2e-qa-visual.test.ts']

function run (command, args, env = {}) {
  return spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }).status ?? 1
}

/** @param {string | undefined} mode @returns {string[]} */
export function specsFor (mode) {
  if (mode === 'all') return QA_SPECS
  if (mode === 'visual') return VISUAL_SPECS
  throw new Error(`unknown qa mode ${JSON.stringify(mode)}: use "all" or "visual"`)
}

if (isInvokedDirectly(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2)
  let specs
  try { specs = specsFor(mode) } catch (error) { console.error(String(error.message)); process.exit(2) }
  if (run('node', ['scripts/build-e2e.mjs']) !== 0) {
    console.error('The e2e build failed; nothing was run and the inspection sheet was not rewritten.')
    process.exit(1)
  }
  const status = run('node', ['scripts/run-headless.mjs', 'npx', 'vitest', 'run', '--config', 'test/vitest.e2e.config.ts', ...specs, ...rest], { ORIVON_QA_PIXELS: '1' })
  run('node', ['scripts/qa-report.mjs'])
  process.exit(status)
}
