/**
 * Rewrites `test/spec-weights.json`, the seconds each e2e spec file takes, from the log of a CI e2e run.
 *
 *   gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs | node scripts/ci/refresh-weights.mjs
 *
 * The log is vitest's verbose reporter: one line per test, ` ✓ test/<area>/e2e-x.test.ts > title 1234ms`. A
 * file's weight is the sum of its tests' durations, rounded up. The weights only balance the shards, so a stale
 * file costs speed, never correctness. Imports `node:*` only.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { WEIGHTS } from './select-e2e.mjs'

const ANSI = /\u001b\[[0-9;]*m/g
const LINE = /[✓×]\s+(test\/\S+\.test\.ts)\s+>.*?(\d+(?:\.\d+)?)(ms|s)$/

/**
 * Seconds per spec file from a verbose log (a job log's timestamp prefix and colour codes are ignored).
 * @returns {Record<string, number>}
 */
export function weightsFromLog (log) {
  const sums = {}
  for (const raw of log.split('\n')) {
    const match = LINE.exec(raw.replace(ANSI, '').trim())
    if (match === null) continue
    const seconds = match[3] === 'ms' ? Number(match[2]) / 1000 : Number(match[2])
    sums[match[1]] = (sums[match[1]] ?? 0) + seconds
  }
  return Object.fromEntries(Object.keys(sums).sort().map((file) => [file, Math.max(1, Math.ceil(sums[file]))]))
}

if (isInvokedDirectly(import.meta.url)) {
  const input = readFileSync(0, 'utf8')
  const weights = weightsFromLog(input)
  const files = Object.keys(weights)
  if (files.length === 0) {
    console.error('No vitest verbose test lines found on stdin: pass the log of an e2e job.')
    process.exit(1)
  }
  writeFileSync(join(process.cwd(), WEIGHTS), `${JSON.stringify(weights, null, 2)}\n`)
  const total = files.reduce((sum, file) => sum + (weights[file] ?? 0), 0)
  console.log(`Wrote ${WEIGHTS}: ${String(files.length)} spec files, ${String(total)} s in all.`)
}
