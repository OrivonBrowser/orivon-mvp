// A dependency advisory fails the build at HIGH or CRITICAL, and not below
// (docs/open-questions.md A121). The repo ships runtime dependencies, so "we
// would have noticed" stopped being true.
//
// Why a script rather than a bare `npm audit --audit-level=high` step: that
// command exits non-zero both when it FINDS advisories and when it cannot
// REACH the registry, and those must not look alike. A guard that treats a
// network failure as "nothing found" fails open, which is the exact defect
// class the 2026-09-11 audit found in this repo's own CI (a check that rebuilt
// out/ and then scanned what it had just built).

import { spawnSync } from 'node:child_process'
import { commandLine, isInvokedDirectly } from './cli.mjs'

const THRESHOLD = ['high', 'critical']

/**
 * Advisories at the gate that are let through, each with why it cannot reach
 * a person. One id each, never a package: another advisory in the same package
 * still fails the build. An entry goes once a fixed release ships.
 */
export const ACCEPTED = new Map([
  ['GHSA-ch52-4w7c-c8xp', 'http-cache-semantics is reached only through electron-builder\'s Electron download at packaging time, whose cache serves one user; no fixed release exists (decision-log d-0413)']
])

/** The GHSA id at the end of an advisory URL, or undefined. */
function advisoryId (url) {
  return typeof url === 'string' ? url.split('/').pop() : undefined
}

/**
 * What `npm audit --json`'s report says about the gate: the advisories at or
 * above it that are not accepted (`blocking`), and those that are
 * (`accepted`). `error` is set when the report cannot be read, or when its
 * counts and its advisories disagree; the gate then fails closed.
 */
export function gateAdvisories (report, accepted = ACCEPTED) {
  const counts = report?.metadata?.vulnerabilities
  if (counts === undefined || counts === null || typeof counts !== 'object') {
    return { error: 'npm audit JSON carried no vulnerability counts -- shape changed, or the audit did not complete.' }
  }
  const atGate = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      // A string names the package an advisory arrives through; its own advisory is listed under that package.
      if (typeof via !== 'object' || via === null || !THRESHOLD.includes(via.severity)) continue
      const id = advisoryId(via.url) ?? `${String(via.name)}: ${String(via.title)}`
      atGate.set(id, { id, name: via.name, severity: via.severity, title: via.title })
    }
  }
  const countedAtGate = THRESHOLD.some((level) => (counts[level] ?? 0) > 0)
  if (countedAtGate && atGate.size === 0) {
    return { error: 'npm audit counted high or critical advisories but listed none -- shape changed.' }
  }
  const findings = [...atGate.values()]
  return {
    summary: Object.entries(counts).map(([k, v]) => `${k}=${String(v)}`).join('  '),
    blocking: findings.filter((finding) => !accepted.has(finding.id)),
    accepted: findings.filter((finding) => accepted.has(finding.id))
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const audit = commandLine('npm', ['audit', '--json'])
  const result = spawnSync(audit.file, audit.args, { encoding: 'utf8', shell: audit.shell })

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

  const gate = gateAdvisories(report)
  if (gate.error !== undefined) {
    console.error(gate.error)
    console.error('Failing CLOSED rather than assuming zero.')
    process.exit(1)
  }

  for (const finding of gate.accepted) {
    console.log(`Accepted ${finding.id} (${String(finding.name)}, ${String(finding.severity)}): ${ACCEPTED.get(finding.id) ?? ''}`)
  }
  if (gate.blocking.length === 0) {
    console.log(`No high or critical dependency advisories beyond those accepted (${gate.summary}).`)
    process.exit(0)
  }

  console.error('Dependency advisories at or above the gate:')
  for (const finding of gate.blocking) console.error(`  ${finding.id} ${String(finding.name)} (${String(finding.severity)}): ${String(finding.title)}`)
  console.error(`  ${gate.summary}`)
  console.error('')
  console.error('The gate is high and critical only (docs/open-questions.md A121):')
  console.error('lower severities are reported by `npm audit` and deliberately do not fail the')
  console.error('build, so that this gate stays worth reading. Run `npm audit` for the detail,')
  console.error('and `npm audit fix` where an upgrade exists.')
  process.exit(1)
}
