/**
 * Runs Orivon on GitHub's Windows and macOS runners from any terminal, waits, and brings back what they saw. It
 * starts `.github/workflows/cross-os.yml` on the current branch as it is on GitHub, then saves each system's smoke
 * result, captured screenshots and failure evidence under `qa-artifacts/cross-os/<run id>/` and prints a summary.
 * `--packaged` starts `release.yml` instead: the packages built, installed and launched on each system.
 *
 *   node scripts/ci/cross-os.mjs [--systems windows,macos,linux] [--specs "<e2e spec files or folders>" | --specs none] [--shards <n>]
 *   node scripts/ci/cross-os.mjs --packaged
 *   node scripts/ci/cross-os.mjs --run <run id> | --run latest     reads a run already started (latest: main's nightly)
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { listSpecs, packShards, WEIGHTS } from './select-e2e.mjs'

/** The systems a run can take, and the hosted runner each one runs on. */
export const SYSTEMS = { windows: 'windows-latest', macos: 'macos-latest', linux: 'ubuntu-latest' }
export const DEFAULT_SYSTEMS = 'windows,macos'
/** The QA states spec: it saves a screenshot of every state it reaches, which is how a run shows what it looked like. */
export const DEFAULT_SPECS = 'test/qa/e2e-qa-visual.test.ts'
export const WORKFLOW = 'cross-os.yml'
export const PACKAGED_WORKFLOW = 'release.yml'
export const OUT_DIR = join('qa-artifacts', 'cross-os')
/** Runners one system may split its specs across: GitHub runs 20 jobs of a free account at once, 5 of them macOS. */
export const MAX_SHARDS = 20

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

/** @param {string} text how many runners each system splits its specs across */
export function parseShards (text) {
  const count = Number(text)
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHARDS) throw new Error(`--shards takes a whole number from 1 to ${MAX_SHARDS}, not ${text}`)
  return count
}

/**
 * The spec files `text` names, in order and once each, a folder standing for every spec under it.
 * @param {string[]} specs every spec the e2e config runs (select-e2e.mjs listSpecs)
 */
export function expandSpecs (text, specs) {
  const out = []
  for (const name of text.split(/\s+/).filter(Boolean).map((part) => part.replace(/^\.\//, '').replace(/\/+$/, ''))) {
    const under = specs.filter((spec) => spec.startsWith(`${name}/`))
    for (const file of under.length > 0 ? under : [name]) if (!out.includes(file)) out.push(file)
  }
  return out
}

/**
 * The `run` job's matrix: one entry per system (live-session.yml), or, given `specs`, `shards` entries per system
 * that share the specs by their recorded seconds, each carrying its job's name, its artifact's name and its specs.
 * @param {string} text a comma or space list of system names
 * @param {{ specs?: string, shards?: number, weights?: Record<string, number> }} [options]
 * @returns {{ include: Array<{ system: string, os: string, name?: string, artifact?: string, specs?: string }> }}
 */
export function matrixFor (text, { specs, shards = 1, weights = {} } = {}) {
  const systems = parseSystems(text)
  if (specs === undefined) return { include: systems.map((system) => ({ system, os: SYSTEMS[system] })) }
  const files = specs === 'none' ? [] : specs.split(/\s+/).filter(Boolean)
  const parts = shards > 1 && files.length > 1 ? packShards(files, weights, { targetSeconds: 1, maxShards: shards }).map((shard) => shard.files) : [files]
  return {
    include: systems.flatMap((system) => parts.map((part, at) => ({
      system,
      os: SYSTEMS[system],
      name: parts.length === 1 ? `from source (${system})` : `from source (${system}) ${at + 1} of ${parts.length}`,
      artifact: parts.length === 1 ? `cross-os-${system}` : `cross-os-${system}-${at + 1}`,
      specs: part.length === 0 ? 'none' : part.join(' ')
    })))
  }
}

/** The part of a job's name its artifact and evidence folder are named after: `windows`, or `windows-3` for a shard. */
export function jobLabel (name) {
  const match = /\((\w+)\)(?: (\d+) of \d+)?/.exec(name)
  if (match === null) return undefined
  return match[2] === undefined ? match[1] : `${match[1]}-${match[2]}`
}

/**
 * The run a dispatch started: the newest one on that commit that was not there before it and, given `title`, whose
 * name holds it, so two dispatches on one commit each find their own. `gh workflow run` prints no id, and matching
 * by id rather than by time holds whatever the two clocks say.
 * @param {number[]} before run ids listed before the dispatch
 * @param {Array<{ databaseId: number, headSha: string, displayTitle?: string }>} after runs listed since, newest first
 * @param {string} [title]
 */
export function pickRun (before, after, sha, title) {
  return after.find((run) => run.headSha === sha && !before.includes(run.databaseId) &&
    (title === undefined || (run.displayTitle ?? '').includes(title)))
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
  const verdict = { success: 'PASS', failure: 'FAIL' }[run.conclusion] ?? (run.conclusion || 'unfinished').toUpperCase()
  const out = [`${verdict}  ${run.url}`]
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

export function listRuns (workflow, branch, event) {
  const args = ['run', 'list', '--workflow', workflow, '--limit', '20', '--json', 'databaseId,headSha,displayTitle']
  if (branch !== undefined) args.push('--branch', branch)
  if (event !== undefined) args.push('--event', event)
  return JSON.parse(gh(...args))
}

/** Starts `workflow` on the current branch and returns the new run's id; `title` is a part of the run's name. */
export async function dispatch (workflow, inputs, title) {
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
    const run = pickRun(before, listRuns(workflow, branch, 'workflow_dispatch'), sha, title)
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
    const label = jobLabel(job.name)
    if (label === undefined) continue
    const seen = { screenshots: 0 }
    const into = join(dir, label)
    if (!packaged) {
      try { gh('run', 'download', String(run.databaseId), '-n', `cross-os-${label}`, '-D', into) } catch {}
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
      const specs = arg('specs')
      const weights = existsSync(WEIGHTS) ? JSON.parse(readFileSync(WEIGHTS, 'utf8')) : {}
      console.log(JSON.stringify(matrixFor(arg('matrix'), specs === undefined ? {} : { specs, shards: parseShards(arg('shards') ?? '1'), weights })))
      process.exit(0)
    }
    let id = arg('run')
    if (id === 'latest') {
      id = String(listRuns(workflow, 'main', 'schedule')[0]?.databaseId ?? '')
      if (id === '') throw new Error(`main has no scheduled ${workflow} run yet`)
    }
    if (id === undefined) {
      const systems = arg('systems') ?? DEFAULT_SYSTEMS
      const shards = arg('shards') ?? '1'
      parseSystems(systems)
      parseShards(shards)
      const files = arg('specs') === 'none' ? [] : expandSpecs(arg('specs') ?? DEFAULT_SPECS, listSpecs('.'))
      const missing = files.filter((file) => !existsSync(file))
      if (missing.length > 0) throw new Error(`no such spec file: ${missing.join(', ')}`)
      // The tag goes into the run's name, so dispatches started at once on one commit each find their own run.
      const tag = randomBytes(4).toString('hex')
      id = String(packaged
        ? await dispatch(workflow, {})
        : await dispatch(workflow, { systems, specs: files.length === 0 ? 'none' : files.join(' '), shards, tag }, `run ${tag}`))
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
