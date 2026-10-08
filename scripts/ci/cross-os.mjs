/**
 * Runs Orivon on GitHub's Windows and macOS runners from any terminal, waits, and brings back what they saw. It
 * starts `.github/workflows/cross-os.yml` on the current branch as it is on GitHub, then saves each system's smoke
 * result, captured screenshots and failure evidence under `qa-artifacts/cross-os/<run id>/` and prints a summary.
 * `--packaged` starts `release.yml` instead: the packages built, installed and launched on each system.
 *
 *   node scripts/ci/cross-os.mjs [--systems windows,macos,linux] [--specs "<e2e spec files>" | --specs none]
 *   node scripts/ci/cross-os.mjs --packaged
 *   node scripts/ci/cross-os.mjs --run <run id> | --run latest     reads a run already started (latest: main's nightly)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'

/** The systems a run can take, and the hosted runner each one runs on. */
export const SYSTEMS = { windows: 'windows-latest', macos: 'macos-latest', linux: 'ubuntu-latest' }
export const DEFAULT_SYSTEMS = 'windows,macos'
/** The QA states spec: it saves a screenshot of every state it reaches, which is how a run shows what it looked like. */
export const DEFAULT_SPECS = 'test/qa/e2e-qa-visual.test.ts'
export const WORKFLOW = 'cross-os.yml'
export const PACKAGED_WORKFLOW = 'release.yml'
export const OUT_DIR = join('qa-artifacts', 'cross-os')

const POLL_MS = 30_000
const FIND_RUN_MS = 120_000
const RUN_TIMEOUT_MS = 120 * 60_000
const LOG_LINES = 30

/** @param {string} text a comma or space list of system names */
export function parseSystems (text) {
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  if (names.length === 0) throw new Error('no system named: use windows, macos, linux, or a comma list')
  const unknown = names.filter((name) => !(name in SYSTEMS))
  if (unknown.length > 0) throw new Error(`unknown system ${unknown.join(', ')}: use ${Object.keys(SYSTEMS).join(', ')}`)
  return names
}

/** The `run` job's matrix in cross-os.yml. */
export function matrixFor (text) {
  return { include: parseSystems(text).map((system) => ({ system, os: SYSTEMS[system] })) }
}

/**
 * The run a dispatch started: the newest one on that commit that was not there before it. `gh workflow run`
 * prints no id, and matching by id rather than by time holds whatever the two clocks say.
 * @param {number[]} before run ids listed before the dispatch
 * @param {Array<{ databaseId: number, headSha: string }>} after runs listed since, newest first
 */
export function pickRun (before, after, sha) {
  return after.find((run) => run.headSha === sha && !before.includes(run.databaseId))
}

/**
 * The object `scripts/smoke.mjs` prints, from its stdout: it opens with a line `{` and closes with a line `}`.
 * @returns {{ checks: Array<{ name: string, pass: boolean, detail?: string }>, skipped: unknown[] } | undefined}
 */
export function smokeResult (stdout) {
  const lines = stdout.split(/\r?\n/)
  const start = lines.indexOf('{')
  const end = lines.indexOf('}', start)
  if (start === -1 || end === -1) return undefined
  try { return JSON.parse(lines.slice(start, end + 1).join('\n')) } catch { return undefined }
}

/** Lines of a job log worth reading first: errors and failed specs, timestamps and colours stripped, at most `max`. */
export function logHighlights (log, max = LOG_LINES) {
  return log.split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[\d;]*m/g, ''))
    .filter((line) => /##\[error\]| FAIL |\bFAILED\b|Smoke check FAILED|^\s+- .+ -- /.test(line))
    .slice(0, max)
}

/**
 * The summary printed at the end, one block per job.
 * @param {{ url: string, conclusion: string, jobs: Array<{ name: string, conclusion: string, steps?: Array<{ name: string, conclusion: string }> }> }} run
 * @param {Record<string, { smoke?: ReturnType<typeof smokeResult>, screenshots: number, inspect?: string, failures?: string, highlights?: string[], log?: string }>} evidence by job name
 */
export function summarize (run, evidence) {
  const out = [`${run.conclusion === 'success' ? 'PASS' : 'FAIL'}  ${run.url}`]
  for (const job of run.jobs) {
    const seen = evidence[job.name] ?? { screenshots: 0 }
    out.push('', `${job.conclusion === 'success' ? 'pass' : job.conclusion || 'unfinished'}: ${job.name}`)
    const failed = (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name)
    if (failed.length > 0) out.push(`  failed steps: ${failed.join('; ')}`)
    if (seen.smoke !== undefined) {
      const bad = seen.smoke.checks.filter((check) => !check.pass)
      out.push(`  smoke: ${seen.smoke.checks.length - bad.length}/${seen.smoke.checks.length} checks pass`)
      for (const check of bad) out.push(`    - ${check.name}${check.detail === undefined ? '' : ` -- ${check.detail}`}`)
    }
    if (seen.screenshots > 0) out.push(`  screenshots: ${seen.screenshots}, read ${seen.inspect ?? 'the PNG files'}`)
    if (seen.failures !== undefined) out.push(`  failed specs' evidence: ${seen.failures}`)
    for (const line of seen.highlights ?? []) out.push(`  | ${line}`)
    if (seen.log !== undefined) out.push(`  full log: ${seen.log}`)
  }
  return out.join('\n')
}

function gh (...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

function git (...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function listRuns (workflow, branch, event) {
  const args = ['run', 'list', '--workflow', workflow, '--limit', '20', '--json', 'databaseId,headSha']
  if (branch !== undefined) args.push('--branch', branch)
  if (event !== undefined) args.push('--event', event)
  return JSON.parse(gh(...args))
}

/** Starts `workflow` on the current branch and returns the new run's id. */
async function dispatch (workflow, inputs) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const sha = git('rev-parse', 'HEAD')
  const pushed = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]
  if (pushed !== sha) {
    throw new Error(`origin/${branch} is ${pushed || 'missing'} and HEAD is ${sha.slice(0, 12)}: push the branch first, since the runners test it as it is on GitHub`)
  }
  const before = listRuns(workflow, branch, 'workflow_dispatch').map((run) => run.databaseId)
  gh('workflow', 'run', workflow, '--ref', branch, ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`]))
  console.log(`started ${workflow} on ${branch} at ${sha.slice(0, 12)}`)
  for (const deadline = Date.now() + FIND_RUN_MS; Date.now() < deadline; await sleep(5000)) {
    const run = pickRun(before, listRuns(workflow, branch, 'workflow_dispatch'), sha)
    if (run !== undefined) return run.databaseId
  }
  throw new Error(`no ${workflow} run appeared on ${branch} within ${FIND_RUN_MS / 1000} s: look at gh run list --workflow ${workflow}`)
}

/** Polls until the run ends, printing a line only when a job's state changes. */
async function waitFor (id) {
  const seen = new Map()
  for (const deadline = Date.now() + RUN_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    const run = JSON.parse(gh('run', 'view', String(id), '--json', 'status,conclusion,url,jobs,workflowName'))
    for (const job of run.jobs) {
      const state = job.conclusion || job.status
      if (seen.get(job.name) !== state) console.log(`  ${job.name}: ${state}`)
      seen.set(job.name, state)
    }
    if (run.status === 'completed') return run
  }
  throw new Error(`run ${id} did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes`)
}

function filesUnder (dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
}

/** Downloads each job's artifact and failed log under `dir`, and says what is there. */
function collect (run, dir, packaged) {
  /** @type {Record<string, any>} */
  const evidence = {}
  for (const job of run.jobs) {
    const system = /\((\w+)\)/.exec(job.name)?.[1]
    if (system === undefined) continue
    const seen = { screenshots: 0 }
    const into = join(dir, system)
    if (!packaged) {
      try { gh('run', 'download', String(run.databaseId), '-n', `cross-os-${system}`, '-D', into) } catch {}
      const files = filesUnder(into)
      const smoke = files.find((file) => file.endsWith('smoke.out'))
      if (smoke !== undefined) seen.smoke = smokeResult(readFileSync(smoke, 'utf8'))
      seen.screenshots = files.filter((file) => file.endsWith('.png')).length
      seen.inspect = files.find((file) => file.endsWith('inspect.md'))
      seen.failures = files.find((file) => /latest[\\/]index\.md$/.test(file))
    }
    if (job.conclusion !== 'success' && job.conclusion !== 'skipped') {
      try {
        const log = gh('api', `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`)
        mkdirSync(into, { recursive: true })
        seen.log = join(into, 'job.log')
        writeFileSync(seen.log, log)
        seen.highlights = logHighlights(log)
      } catch {}
    }
    evidence[job.name] = seen
  }
  return evidence
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const packaged = process.argv.includes('--packaged')
    const workflow = packaged ? PACKAGED_WORKFLOW : WORKFLOW
    if (arg('matrix') !== undefined) {
      console.log(JSON.stringify(matrixFor(arg('matrix'))))
      process.exit(0)
    }
    let id = arg('run')
    if (id === 'latest') {
      id = String(listRuns(workflow, 'main', 'schedule')[0]?.databaseId ?? '')
      if (id === '') throw new Error(`main has no scheduled ${workflow} run yet`)
    }
    if (id === undefined) {
      const systems = arg('systems') ?? DEFAULT_SYSTEMS
      const specs = arg('specs') ?? DEFAULT_SPECS
      parseSystems(systems)
      const missing = specs === 'none' ? [] : specs.split(/\s+/).filter((file) => file !== '' && !existsSync(file))
      if (missing.length > 0) throw new Error(`no such spec file: ${missing.join(', ')}`)
      id = String(await dispatch(workflow, packaged ? {} : { systems, specs }))
    }
    const run = { ...(await waitFor(id)), databaseId: Number(id) }
    const dir = join(OUT_DIR, id)
    console.log(`\n${summarize(run, collect(run, dir, packaged))}`)
    if (!packaged) console.log(`\nevidence: ${dir}/<system>/ (smoke.out, install.log, qa-artifacts/latest/)`)
    process.exit(run.conclusion === 'success' ? 0 : 1)
  } catch (error) {
    console.error(`cross-os: ${error.stderr?.trim() || error.message}`)
    process.exit(2)
  }
}
