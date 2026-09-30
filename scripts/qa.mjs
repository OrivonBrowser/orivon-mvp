/**
 * `npm run qa` and `npm run qa:visual`: build the e2e bundle, run the QA
 * specs headless, then write the inspection sheet whether or not they passed.
 * The exit code is the specs'. Extra arguments go to vitest (for example
 * `-t "<test name>"`).
 */
import { spawnSync } from 'node:child_process'
import { isInvokedDirectly } from './cli.mjs'

export const QA_SPECS = ['test/qa-visual.test.ts', 'test/e2e-qa-audit.test.ts', 'test/e2e-qa-visual.test.ts', 'test/e2e-qa-evidence.test.ts', 'test/e2e-qa-journey.test.ts', 'test/e2e-qa-adversarial.test.ts']
export const VISUAL_SPECS = ['test/qa-visual.test.ts', 'test/e2e-qa-audit.test.ts', 'test/e2e-qa-visual.test.ts']

function run (command, args) {
  return spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1
}

if (isInvokedDirectly(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2)
  const specs = mode === 'visual' ? VISUAL_SPECS : QA_SPECS
  let status = run('node', ['scripts/build-e2e.mjs'])
  if (status === 0) status = run('node', ['scripts/run-headless.mjs', 'npx', 'vitest', 'run', '--config', 'test/vitest.e2e.config.ts', ...specs, ...rest])
  run('node', ['scripts/qa-report.mjs'])
  process.exit(status)
}
