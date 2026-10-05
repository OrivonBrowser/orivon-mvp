/**
 * Decides which end-to-end specs CI runs, and splits them into shards.
 *
 * `node scripts/ci/select-e2e.mjs --event pull_request --base origin/main [--fork] [--labels a,b]` prints a JSON
 * plan; under GitHub Actions it also writes `mode`, `count` and `matrix` to `$GITHUB_OUTPUT`. A plan is `none`
 * (nothing selected), `impacted` (the specs the changed files map to) or `full` (every spec). Anything the map
 * does not know runs everything. Run it locally to see what CI would run; nothing here enforces anything.
 *
 * Imports `node:*` and a sibling guard's catalogue parser only.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { CATALOGUE, parseCatalogue } from '../app-behaviours/check-app-behaviours.mjs'

export const IMPACT_MAP = 'test/impact-map.json'
export const WEIGHTS = 'test/spec-weights.json'
export const FULL = '@full'
export const CORE = '@core'
export const TARGET_SECONDS = 240
export const MAX_SHARDS = 10

/** Every spec the e2e config runs, as repo-relative posix paths: `*.test.ts` under `test/` except `test/apps/`. */
export function listSpecs (root) {
  const out = []
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) { if (!(rel === 'test' && entry.name === 'apps')) walk(child) } else if (entry.name.endsWith('.test.ts')) out.push(child)
    }
  }
  walk('test')
  return out.sort()
}

/** The area folder a spec lives in (`test/<area>/...`), or '' for a spec at the top of `test/`. */
export function areaOf (spec) {
  const parts = spec.split('/')
  return parts.length > 2 ? parts[1] : ''
}

/** The area folders that hold specs. */
export function areasOf (specs) {
  return [...new Set(specs.map(areaOf).filter((area) => area !== ''))].sort()
}

/** The specs the catalogue names as proof of a row, as repo-relative paths. */
export function catalogueSpecs (root) {
  try {
    const entries = parseCatalogue(readFileSync(join(root, CATALOGUE), 'utf8')).entries
    return [...new Set(entries.flatMap((entry) => entry.specs))].sort()
  } catch {
    return []
  }
}

/** Whether a rule covers a file: its prefix is a path (the file or a folder above it), or ends in `*` for a name prefix. */
export function ruleMatches (rule, file) {
  const prefix = rule.prefix
  if (prefix.endsWith('*')) return file.startsWith(prefix.slice(0, -1))
  return file === prefix || file.startsWith(`${prefix}/`)
}

/** What a changed file asks for: the tokens of its most specific rule, `[]` for an ignored file, `[FULL]` when unknown. */
export function tokensFor (map, file) {
  for (const pattern of map.ignore ?? []) if (new RegExp(pattern).test(file)) return []
  let best = null
  for (const rule of map.rules) {
    if (ruleMatches(rule, file) && (best === null || rule.prefix.length > best.prefix.length)) best = rule
  }
  return best === null ? (map.fallback ?? [FULL]) : best.run
}

/** The specs a token names: an area folder, the app core, or everything. */
export function specsForToken (token, { map, specs, catalogue }) {
  if (token === FULL) return specs
  if (token === CORE) {
    const core = map.core ?? {}
    const areas = new Set(core.areas ?? [])
    const named = new Set([...(core.specs ?? []), ...(core.catalogue === false ? [] : catalogue)])
    return specs.filter((spec) => areas.has(areaOf(spec)) || named.has(spec))
  }
  return specs.filter((spec) => areaOf(spec) === token)
}

/**
 * The specs the changed files ask for.
 * @returns {{ mode: 'none' | 'impacted' | 'full', files: string[], areas: string[] }}
 */
export function selectImpacted ({ map, changed, specs, catalogue }) {
  const chosen = new Set()
  let full = false
  for (const file of changed) {
    for (const token of tokensFor(map, file)) {
      if (token === FULL) full = true
      else for (const spec of specsForToken(token, { map, specs, catalogue })) chosen.add(spec)
    }
  }
  if (full) return { mode: 'full', files: [...specs], areas: areasOf(specs) }
  const files = [...chosen].sort()
  return { mode: files.length === 0 ? 'none' : 'impacted', files, areas: areasOf(files) }
}

/**
 * The plan for an event.
 * @param {{ event: string, ref?: string, fork?: boolean, labels?: string[], dispatchAreas?: string, changed: string[], map: object, specs: string[], catalogue: string[] }} input
 * @returns {{ mode: 'none' | 'impacted' | 'full', reason: string, files: string[], areas: string[] }}
 */
export function decide (input) {
  const { event, ref = '', fork = false, labels = [], dispatchAreas = 'impacted', changed, map, specs, catalogue } = input
  const full = (reason) => ({ mode: 'full', reason, files: [...specs], areas: areasOf(specs) })
  const none = (reason) => ({ mode: 'none', reason, files: [], areas: [] })
  if (event === 'schedule') return full('the nightly run covers everything')
  if (event === 'push' && (ref === 'main' || ref === 'refs/heads/main')) return full('main runs everything after a merge')
  if (event === 'workflow_dispatch') {
    if (dispatchAreas === 'all') return full('dispatched with areas=all')
    if (dispatchAreas !== 'impacted' && dispatchAreas.trim() !== '') {
      const asked = dispatchAreas.split(',').map((area) => area.trim()).filter(Boolean)
      const files = specs.filter((spec) => asked.includes(areaOf(spec)))
      return files.length === 0 ? none(`no spec in the areas ${asked.join(', ')}`) : { mode: 'impacted', reason: `dispatched with areas=${asked.join(',')}`, files, areas: areasOf(files) }
    }
  }
  if (labels.includes('ci:e2e-full')) return full('the ci:e2e-full label')
  if (event === 'pull_request' && fork && !labels.includes('ci:e2e')) return none('a pull request from a fork runs e2e only after a maintainer adds the ci:e2e label')
  const picked = selectImpacted({ map, changed, specs, catalogue })
  const reason = picked.mode === 'full' ? 'a changed file is not in the impact map, or needs everything' : picked.mode === 'none' ? 'no changed file reaches an e2e spec' : `the areas the changed files reach: ${picked.areas.join(', ')}`
  return { ...picked, reason }
}

/** The seconds a spec is expected to take: its recorded weight, or the median of the recorded ones. */
export function weightOf (spec, weights) {
  if (typeof weights[spec] === 'number') return weights[spec]
  const known = Object.values(weights).filter((value) => typeof value === 'number').sort((a, b) => a - b)
  return known.length === 0 ? 15 : known[Math.floor(known.length / 2)]
}

/**
 * Packs specs into shards of about `targetSeconds` each, longest first onto the lightest shard.
 * @returns {Array<{ shard: number, seconds: number, files: string[] }>}
 */
export function packShards (files, weights, { targetSeconds = TARGET_SECONDS, maxShards = MAX_SHARDS } = {}) {
  if (files.length === 0) return []
  const weighted = files.map((file) => ({ file, seconds: weightOf(file, weights) })).sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file))
  const total = weighted.reduce((sum, item) => sum + item.seconds, 0)
  const count = Math.max(1, Math.min(maxShards, files.length, Math.ceil(total / targetSeconds)))
  const shards = Array.from({ length: count }, (_, i) => ({ shard: i + 1, seconds: 0, files: [] }))
  for (const item of weighted) {
    const lightest = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a))
    lightest.files.push(item.file)
    lightest.seconds += item.seconds
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

function git (root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Files changed between the merge base of `base` and `head`, old and new names of a rename both included. */
export function changedFiles (root, base, head = 'HEAD') {
  const mergeBase = git(root, 'merge-base', base, head).trim()
  return git(root, 'diff', '--name-only', '--no-renames', `${mergeBase}...${head}`).split('\n').filter(Boolean)
}

function arg (name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const map = JSON.parse(readFileSync(join(root, IMPACT_MAP), 'utf8'))
  const specs = listSpecs(root)
  const weights = existsSync(join(root, WEIGHTS)) ? JSON.parse(readFileSync(join(root, WEIGHTS), 'utf8')) : {}
  const event = arg('event') ?? 'pull_request'
  const base = arg('base') ?? 'origin/main'
  let changed = []
  if (!['schedule', 'push'].includes(event) || arg('base') !== undefined) {
    try { changed = changedFiles(root, base, arg('head') ?? 'HEAD') } catch (err) { console.error(`could not diff against ${base}: ${err.message}`); process.exit(1) }
  }
  const plan = decide({
    event,
    ref: arg('ref') ?? '',
    fork: process.argv.includes('--fork'),
    labels: (arg('labels') ?? '').split(',').map((label) => label.trim()).filter(Boolean),
    dispatchAreas: arg('areas') ?? 'impacted',
    changed,
    map,
    specs,
    catalogue: catalogueSpecs(root)
  })
  const shards = packShards(plan.files, weights)
  const matrix = { include: shards.map((shard) => ({ shard: shard.shard, files: shard.files.join(' ') })) }
  const seconds = shards.reduce((sum, shard) => sum + shard.seconds, 0)
  const summary = `e2e: ${plan.mode}: ${plan.reason}. ${plan.files.length} spec files, about ${Math.round(seconds)} s, ${shards.length} shard(s)${plan.areas.length > 0 ? `; areas: ${plan.areas.join(', ')}` : ''}.`
  console.log(summary)
  if (process.argv.includes('--explain')) for (const file of changed) console.log(`  ${file} -> ${tokensFor(map, file).join(' ') || 'ignored'}`)
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...plan, shards }, null, 2))
  else if (shards.length > 0 && !process.env['GITHUB_OUTPUT']) console.log(`Run: node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts ${plan.files.join(' ')}`)
  if (process.env['GITHUB_OUTPUT']) {
    appendFileSync(process.env['GITHUB_OUTPUT'], `mode=${plan.mode}\ncount=${String(shards.length)}\nmatrix=${JSON.stringify(matrix)}\n`)
    if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${summary}\n`)
  }
}
