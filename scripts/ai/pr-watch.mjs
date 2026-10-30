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
//   node scripts/ai/pr-watch.mjs <pr> [--update <worktree>] [--stop <spec regex>] [--reruns 2] [--no-merge | --squash]
//   exit 0 merged (or green, with --no-merge) · 1 a check failed · 2 BEHIND or DIRTY · 3 the head moved · 4 timeout
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from '../cli.mjs'
import { LOG } from './renumber-decisions.mjs'

const POLL_MS = 30_000
const AFTER_RERUN_MS = 90_000
const TIMEOUT_MS = 3 * 60 * 60_000
const MAX_ROUNDS = 6
const PUSH_SEEN_MS = 120_000
const PUSH_ATTEMPTS = 3
const PUSH_RETRY_MS = 5000
const RENUMBER = fileURLToPath(new URL('./renumber-decisions.mjs', import.meta.url))
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR'])
/** Checks whose failure is rerun before it counts: e2e flakes, and hosted runners that were never acquired. */
const RERUNNABLE = /^(e2e|e2e-ordinary|e2e-shard-\d+|live \(\w+\)|from source \(\w+\))$/

/**
 * One entry of `statusCheckRollup`, check run or commit status, as name, conclusion ('' while pending), URL and workflow.
 * @param {{ name?: string, context?: string, conclusion?: string, state?: string, detailsUrl?: string, targetUrl?: string, workflowName?: string }} check
 */
export function normalize (check) {
  const state = check.state === 'PENDING' || check.state === 'EXPECTED' ? '' : check.state
  return { name: check.name ?? check.context ?? '', conclusion: check.conclusion || state || '', url: check.detailsUrl ?? check.targetUrl ?? '', workflow: check.workflowName ?? '' }
}

/** The workflow run a check's job URL names; none for a commit status or another app's check. */
const runOf = (check) => /\/runs\/(\d+)\//.exec(check.url)?.[1]

/**
 * The checks without the runs a later run on this commit replaced: a `ci:` label or a re-run starts a fresh run that
 * cancels the one before, which stays in the rollup next to its replacement. All of it goes, not only its cancelled
 * jobs: its `e2e` summary runs whatever happened and fails, and a matrix cut off before it expanded keeps an unexpanded
 * name nothing replaces. A later skipped job replaces nothing: a label that is not `ci:` starts a run of skipped jobs
 * next to the real one, and reading that as a replacement would merge past a real failure.
 * @template {{ name: string, conclusion: string, url?: string, workflow?: string }} T
 * @param {T[]} checks
 * @returns {T[]}
 */
function current (checks) {
  const replaces = (later, check) => later.name === check.name && later.workflow === check.workflow &&
    later.conclusion !== 'CANCELLED' && later.conclusion !== 'SKIPPED' && Number(runOf(later)) > Number(runOf(check))
  const replaced = new Set(checks.filter((check) => check.conclusion === 'CANCELLED' && checks.some((later) => replaces(later, check))).map(runOf))
  return checks.filter((check) => !replaced.has(runOf(check)))
}

/**
 * The PR's head once it is `wanted`, or the last one read when `budgetMs` runs out: GitHub moves a PR's head some
 * seconds after a push lands, so a watch started right after a push would otherwise call it missing.
 * @param {() => string} readHead
 * @param {string} wanted
 * @param {{ budgetMs: number, pollMs: number, sleep: (ms: number) => Promise<void> }} timing
 */
export async function headOnceSeen (readHead, wanted, { budgetMs, pollMs, sleep }) {
  let head = readHead()
  for (let waited = 0; head !== wanted && waited < budgetMs; waited += pollMs) {
    await sleep(pollMs)
    head = readHead()
  }
  return head
}

/**
 * What to do next for checks in this state.
 * @param {{ checks: Array<{ name: string, conclusion: string, url?: string, workflow?: string }>, state: string, reruns: number, maxReruns: number }} now
 * @returns {{ step: 'wait' | 'merge' | 'rerun' | 'fail' | 'stuck', failed?: string[] }}
 */
export function nextStep ({ checks: all, state, reruns, maxReruns }) {
  const checks = current(all)
  if (checks.length === 0 || checks.some((check) => check.conclusion === '')) return { step: 'wait' }
  const failed = checks.filter((check) => FAILED.has(check.conclusion)).map((check) => check.name)
  if (failed.length > 0) {
    // Failures on a base main has moved past may be fixed there: merging main in comes before any verdict. DIRTY is
    // that and a conflict, which updateBranch settles when it is the decision log's alone.
    if (state === 'BEHIND' || state === 'DIRTY') return { step: 'stale', failed }
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
  return [...new Set(current(checks).filter((check) => FAILED.has(check.conclusion)).map(runOf).filter(Boolean))]
}

/**
 * Merges `origin/main` into the branch checked out in `worktree` and pushes it to the pull request's own branch,
 * `headRef`, whatever the local branch is called; returns the new head, or undefined when the merge conflicts, after
 * aborting it so the worktree is as it was. A conflict in the decision log alone is settled by renumber-decisions.mjs.
 */
export function updateBranch (worktree, headRef) {
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('fetch', '-q', 'origin')
  try {
    git('merge', '-q', '--no-edit', 'origin/main')
  } catch {
    // Two branches that each add a decision row conflict on the log and nowhere else: renumber-decisions settles that.
    const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter((file) => file !== '')
    let settled = false
    if (conflicted.length === 1 && conflicted[0] === LOG) {
      try {
        execFileSync(process.execPath, [RENUMBER], { cwd: worktree, stdio: 'ignore' })
        settled = !/^<{7} /m.test(readFileSync(join(worktree, LOG), 'utf8'))
      } catch {}
    }
    if (!settled) {
      try { git('merge', '--abort') } catch {}
      return undefined
    }
    git('add', '-u')
    git('commit', '-q', '--no-edit')
  }
  // A plain `push origin HEAD` goes to the local branch's name: renamed locally, it made a second remote branch and left the PR behind.
  // GitHub now and then rejects a good push ("fatal error in commit_refs"), so it is tried three times.
  for (let attempt = 1; ; attempt += 1) {
    try {
      git('push', '-q', 'origin', `HEAD:refs/heads/${headRef}`)
      break
    } catch (error) {
      if (attempt === PUSH_ATTEMPTS) throw new Error(`pushing to ${headRef} failed ${String(PUSH_ATTEMPTS)} times: ${String(error.stderr ?? error.message).trim()}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PUSH_RETRY_MS)
    }
  }
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
  const view = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefName,headRefOid,mergeStateStatus,statusCheckRollup'))
  return { headRef: view.headRefName, head: view.headRefOid, state: view.mergeStateStatus, checks: view.statusCheckRollup.map(normalize) }
}

/** Prints each failed e2e shard's failed specs, and returns them all. */
function reportSpecs (checks) {
  const all = []
  for (const check of current(checks).filter((c) => FAILED.has(c.conclusion) && /^e2e-shard-\d+$/.test(c.name))) {
    const job = /\/job\/(\d+)/.exec(check.url)?.[1]
    let specs = []
    try { specs = job === undefined ? [] : failedSpecs(gh('api', `repos/{owner}/{repo}/actions/jobs/${job}/logs`)) } catch {}
    console.log(`  ${check.name}: ${specs.join('; ') || 'no failed spec in its log'}`)
    all.push(...specs)
  }
  return all
}

async function watch (pr, { maxReruns, merge, squash, stop, worktree }) {
  let { head } = read(pr)
  if (worktree !== undefined) {
    const local = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    head = await headOnceSeen(() => read(pr).head, local, { budgetMs: PUSH_SEEN_MS, pollMs: 5000, sleep })
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
    let next = nextStep({ checks: now.checks, state: now.state, reruns, maxReruns })
    if (next.step === 'stale') next = worktree !== undefined && rounds < MAX_ROUNDS ? { step: 'stuck' } : { step: 'fail', failed: next.failed }
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
      try {
        gh('pr', 'merge', pr, squash ? '--squash' : '--merge')
      } catch (error) {
        // Another merge landed between the read and this one: the next poll sees BEHIND and updates the branch.
        if (!/Base branch was modified/i.test(String(error.stderr ?? error.message))) throw error
        console.log('main moved while merging: watching again')
        said = ''
        continue
      }
      console.log(`merged #${pr}${reruns > 0 ? ` after ${String(reruns)} rerun(s): name the flakes above in the PR` : ''}`)
      return 0
    } else if (next.step === 'stuck') {
      if (worktree === undefined || (now.state !== 'BEHIND' && now.state !== 'DIRTY') || rounds >= MAX_ROUNDS) {
        console.log(`green but ${now.state}: merge main into the branch and push, then watch again`)
        return 2
      }
      let updated
      try {
        updated = updateBranch(worktree, now.headRef)
      } catch (error) {
        console.log(`${error.message}: push the merged branch by hand, then watch again`)
        return 2
      }
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

/** Whether a process with this pid exists: signal 0 checks without sending anything. */
function alive (pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

if (isInvokedDirectly(import.meta.url)) {
  const pr = process.argv[2]
  if (pr === undefined || !/^\d+$/.test(pr)) {
    console.error('usage: node scripts/ai/pr-watch.mjs <pr> [--update <worktree>] [--stop <spec regex>] [--reruns 2] [--no-merge | --squash]')
    process.exit(2)
  }
  // Two watchers on one PR both merge main into the same worktree, and one's `merge --abort` undoes the other's merge.
  const lock = join(tmpdir(), `orivon-pr-watch-${pr}.lock`)
  const holder = (() => { try { return Number(readFileSync(lock, 'utf8')) } catch { return 0 } })()
  if (holder > 0 && holder !== process.pid && alive(holder)) {
    console.error(`another pr-watch (pid ${String(holder)}) is watching #${pr}: stop it first`)
    process.exit(2)
  }
  writeFileSync(lock, String(process.pid))
  process.on('exit', () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock) } catch {} })
  process.exit(await watch(pr, {
    maxReruns: Number(arg('reruns') ?? 2),
    merge: !process.argv.includes('--no-merge'),
    squash: process.argv.includes('--squash'),
    stop: arg('stop') === undefined ? undefined : new RegExp(arg('stop')),
    worktree: arg('update')
  }))
}
