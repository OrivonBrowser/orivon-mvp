#!/usr/bin/env node
// Waits for a pull request's checks and merges it once every one passed and GitHub calls it CLEAN, so a session
// does not hand-write a polling loop. A failed e2e shard, or a cross-OS or live-session job (a runner may never be
// acquired), is rerun at most `--reruns` times, and the failed specs are printed so the PR can name them as flakes
// (CLAUDE.md Rule 12); a failed spec matching `--stop` (your own area) is never rerun. Any other failure stops it, as
// does a moved head. Green but BEHIND, `--update <worktree>` merges `main` into the branch checked out there,
// pushes and watches again (six rounds at most); without it, or on a conflict, it stops for the session that owns the
// branch. BLOCKED is waited out: GitHub says it while required checks run, and for a moment after. Run it in the
// background; it prints only what changed.
//
//   node scripts/ai/pr-watch.mjs <pr> [--update <worktree>] [--stop <spec regex>] [--reruns 2] [--no-merge]
//   exit 0 merged (or green, with --no-merge) · 1 a check failed · 2 BEHIND or DIRTY · 3 the head moved · 4 timeout
import { execFileSync } from 'node:child_process'
import { isInvokedDirectly } from '../cli.mjs'

const POLL_MS = 30_000
const AFTER_RERUN_MS = 90_000
const TIMEOUT_MS = 3 * 60 * 60_000
const MAX_ROUNDS = 6
const PUSH_SEEN_MS = 120_000
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])
/** Checks whose failure is rerun before it counts: e2e flakes, and hosted runners that were never acquired. */
const RERUNNABLE = /^(e2e|e2e-ordinary|e2e-shard-\d+|live \(\w+\)|from source \(\w+\))$/

/**
 * One entry of `statusCheckRollup`, check run or commit status, as name, conclusion ('' while pending) and URL.
 * @param {{ name?: string, context?: string, conclusion?: string, state?: string, detailsUrl?: string, targetUrl?: string }} check
 */
export function normalize (check) {
  const state = check.state === 'PENDING' || check.state === 'EXPECTED' ? '' : check.state
  return { name: check.name ?? check.context ?? '', conclusion: check.conclusion || state || '', url: check.detailsUrl ?? check.targetUrl ?? '' }
}

/**
 * What to do next for checks in this state.
 * @param {{ checks: Array<{ name: string, conclusion: string }>, state: string, reruns: number, maxReruns: number }} now
 * @returns {{ step: 'wait' | 'merge' | 'rerun' | 'fail' | 'stuck', failed?: string[] }}
 */
export function nextStep ({ checks, state, reruns, maxReruns }) {
  if (checks.length === 0 || checks.some((check) => check.conclusion === '')) return { step: 'wait' }
  const failed = checks.filter((check) => FAILED.has(check.conclusion)).map((check) => check.name)
  if (failed.length > 0) {
    return failed.every((name) => RERUNNABLE.test(name)) && reruns < maxReruns ? { step: 'rerun', failed } : { step: 'fail', failed }
  }
  if (state === 'CLEAN') return { step: 'merge' }
  if (state === 'BEHIND' || state === 'DIRTY') return { step: 'stuck' }
  return { step: 'wait' }
}

/** The spec files and test names a vitest log reports as failed, colours and timestamps stripped. */
export function failedSpecs (log) {
  const found = new Set()
  for (const line of log.split(/\r?\n/)) {
    const plain = line.replace(/\x1b\[[\d;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')
    const match = /\bFAIL\s+(\S+\.test\.[cm]?[jt]s)(?:\s+>\s+(.*))?$/.exec(plain.trim())
    if (match !== null) found.add(match[2] === undefined ? match[1] : `${match[1]} > ${match[2]}`)
  }
  return [...found]
}

/** The workflow run ids of failed checks, from their job URLs. */
export function runIds (checks) {
  return [...new Set(checks.filter((check) => FAILED.has(check.conclusion)).map((check) => /\/runs\/(\d+)\//.exec(check.url)?.[1]).filter(Boolean))]
}

/**
 * Merges `origin/main` into the branch checked out in `worktree` and pushes it; returns the new head, or undefined
 * when the merge conflicts, after aborting it so the worktree is as it was.
 */
export function updateBranch (worktree) {
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('fetch', '-q', 'origin')
  try {
    git('merge', '-q', '--no-edit', 'origin/main')
  } catch {
    try { git('merge', '--abort') } catch {}
    return undefined
  }
  git('push', '-q', 'origin', 'HEAD')
  return git('rev-parse', 'HEAD')
}

function gh (...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function read (pr) {
  const view = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefOid,mergeStateStatus,statusCheckRollup'))
  return { head: view.headRefOid, state: view.mergeStateStatus, checks: view.statusCheckRollup.map(normalize) }
}

/** Prints each failed e2e shard's failed specs, and returns them all. */
function reportSpecs (checks) {
  const all = []
  for (const check of checks.filter((c) => FAILED.has(c.conclusion) && /^e2e-shard-\d+$/.test(c.name))) {
    const job = /\/job\/(\d+)/.exec(check.url)?.[1]
    let specs = []
    try { specs = job === undefined ? [] : failedSpecs(gh('api', `repos/{owner}/{repo}/actions/jobs/${job}/logs`)) } catch {}
    console.log(`  ${check.name}: ${specs.join('; ') || 'no failed spec in its log'}`)
    all.push(...specs)
  }
  return all
}

async function watch (pr, { maxReruns, merge, stop, worktree }) {
  let { head } = read(pr)
  if (worktree !== undefined) {
    const local = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (local !== head) { console.log(`${worktree} is at ${local.slice(0, 8)}, the PR at ${head.slice(0, 8)}: push it or name the right worktree`); return 2 }
  }
  let reruns = 0
  let rounds = 0
  let said = ''
  for (const deadline = Date.now() + TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    let now
    try { now = read(pr) } catch { continue }
    if (now.head !== head) { console.log(`head moved from ${head.slice(0, 8)} to ${now.head.slice(0, 8)}`); return 3 }
    const pending = now.checks.filter((check) => check.conclusion === '').length
    const line = `${now.state}, ${String(pending)} of ${String(now.checks.length)} checks pending`
    if (line !== said) { console.log(line); said = line }
    const next = nextStep({ checks: now.checks, state: now.state, reruns, maxReruns })
    if (next.step === 'rerun' || next.step === 'fail') {
      console.log(`failed: ${(next.failed ?? []).join(', ')}`)
      const specs = reportSpecs(now.checks)
      if (next.step === 'fail') return 1
      if (stop !== undefined && specs.some((spec) => stop.test(spec))) { console.log(`a failed spec matches --stop ${String(stop)}: not rerun`); return 1 }
      for (const id of runIds(now.checks)) { try { gh('run', 'rerun', id, '--failed'); console.log(`reran the failed jobs of run ${id}`) } catch {} }
      reruns += 1
      said = ''
      await sleep(AFTER_RERUN_MS)
    } else if (next.step === 'merge') {
      if (!merge) { console.log('green and CLEAN'); return 0 }
      gh('pr', 'merge', pr, '--merge')
      console.log(`merged #${pr}${reruns > 0 ? ` after ${String(reruns)} rerun(s): name the flakes above in the PR` : ''}`)
      return 0
    } else if (next.step === 'stuck') {
      if (worktree === undefined || now.state !== 'BEHIND' || rounds >= MAX_ROUNDS) {
        console.log(`green but ${now.state}: merge main into the branch and push, then watch again`)
        return 2
      }
      const updated = updateBranch(worktree)
      if (updated === undefined) { console.log('main does not merge into the branch cleanly: settle the conflict by hand'); return 2 }
      rounds += 1
      console.log(`round ${String(rounds)}: merged main in and pushed ${updated.slice(0, 8)}`)
      for (const seen = Date.now() + PUSH_SEEN_MS; Date.now() < seen && read(pr).head !== updated; await sleep(5000));
      head = updated
      reruns = 0
      said = ''
      continue
    }
    head = now.head
  }
  console.log('no verdict within three hours')
  return 4
}

if (isInvokedDirectly(import.meta.url)) {
  const pr = process.argv[2]
  if (pr === undefined || !/^\d+$/.test(pr)) {
    console.error('usage: node scripts/ai/pr-watch.mjs <pr> [--update <worktree>] [--stop <spec regex>] [--reruns 2] [--no-merge]')
    process.exit(2)
  }
  process.exit(await watch(pr, {
    maxReruns: Number(arg('reruns') ?? 2),
    merge: !process.argv.includes('--no-merge'),
    stop: arg('stop') === undefined ? undefined : new RegExp(arg('stop')),
    worktree: arg('update')
  }))
}
