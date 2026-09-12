// Owner decision d-L (docs/open-questions.md A121): a dependency advisory
// fails the build at HIGH or CRITICAL, and not below. The repo ships runtime
// dependencies now, so "we would have noticed" stopped being true.
//
// Why a script rather than a bare `npm audit --audit-level=high` step: that
// command exits non-zero both when it FINDS advisories and when it cannot
// REACH the registry, and those must not look alike. A guard that treats a
// network failure as "nothing found" fails open, which is the exact defect
// class the 2026-09-11 audit found in this repo's own CI (a check that rebuilt
// out/ and then scanned what it had just built).

import { spawnSync } from 'node:child_process'

const THRESHOLD = ['high', 'critical']

const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: false })

if (result.error !== undefined) {
  console.error(`Could not run npm audit: ${result.error.message}`)
  console.error('Failing CLOSED -- an advisory gate that cannot run must not report clean.')
  process.exit(1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  // npm audit prints JSON on both the clean and the dirty path; unparseable
  // output means something else went wrong (a proxy page, an auth prompt, a
  // registry outage), never "no advisories".
  console.error('npm audit produced output that is not JSON -- the registry may be unreachable.')
  console.error(result.stdout.slice(0, 400) || result.stderr.slice(0, 400))
  console.error('Failing CLOSED.')
  process.exit(1)
}

const counts = report?.metadata?.vulnerabilities
if (counts === undefined || typeof counts !== 'object') {
  console.error('npm audit JSON carried no vulnerability counts -- shape changed, or the audit did not complete.')
  console.error('Failing CLOSED rather than assuming zero.')
  process.exit(1)
}

const blocking = THRESHOLD.filter((level) => (counts[level] ?? 0) > 0)
const summary = Object.entries(counts).map(([k, v]) => `${k}=${String(v)}`).join('  ')

if (blocking.length === 0) {
  console.log(`No high or critical dependency advisories (${summary}).`)
  process.exit(0)
}

console.error(`Dependency advisories at or above the gate: ${blocking.join(', ')}`)
console.error(`  ${summary}`)
console.error('')
console.error('The gate is high and critical only (owner decision, docs/open-questions.md A121):')
console.error('lower severities are reported by `npm audit` and deliberately do not fail the')
console.error('build, so that this gate stays worth reading. Run `npm audit` for the detail,')
console.error('and `npm audit fix` where an upgrade exists.')
process.exit(1)
