/**
 * Keeps `test/impact-map.json`, which says which e2e areas a changed file reaches, in step with the tree. Fails
 * when a directory directly under `src/`, or under `src/main/`, has no rule of its own (so a new directory forces
 * the decision of what exercises it), when a rule names an area that does not exist or a path no tracked file
 * has, when an area folder of `test/` has no rule for edits to its own specs, or when `core` names a missing
 * area or spec. Imports `node:*` and sibling scripts only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { trackedFiles } from '../check-test-paths.mjs'
import { CORE, FULL, IMPACT_MAP, areasOf, listSpecs, ruleMatches } from './select-e2e.mjs'

/**
 * @param {{ map: any, specs: string[], srcDirs: string[], mainDirs: string[], tracked: string[] }} input
 * @returns {string[]} one message per problem
 */
export function checkImpactMap ({ map, specs, srcDirs, mainDirs, tracked }) {
  const problems = []
  if (!Array.isArray(map?.rules)) return [`${IMPACT_MAP} has no \`rules\` array`]
  const areas = areasOf(specs)
  const valid = new Set([CORE, FULL, ...areas])
  const prefixes = new Map()
  for (const [index, rule] of map.rules.entries()) {
    if (typeof rule?.prefix !== 'string' || !Array.isArray(rule.run)) { problems.push(`rule ${String(index)} needs a string \`prefix\` and a \`run\` array`); continue }
    if (prefixes.has(rule.prefix)) problems.push(`two rules for \`${rule.prefix}\``)
    prefixes.set(rule.prefix, rule)
    for (const token of rule.run) if (!valid.has(token)) problems.push(`rule \`${rule.prefix}\` names \`${String(token)}\`, which is neither ${CORE}, ${FULL} nor an area folder of test/`)
    if (!tracked.some((file) => ruleMatches(rule, file))) problems.push(`rule \`${rule.prefix}\` matches no tracked file: remove it or fix the path`)
  }
  for (const dir of srcDirs) {
    if (!prefixes.has(`src/${dir}`)) problems.push(`src/${dir}/ has no rule in ${IMPACT_MAP}: say which e2e areas exercise it (${CORE}, an area list, or ${FULL})`)
  }
  for (const dir of mainDirs) {
    if (!prefixes.has(`src/main/${dir}`)) problems.push(`src/main/${dir}/ has no rule in ${IMPACT_MAP}: say which e2e areas exercise it (${CORE}, an area list, or ${FULL})`)
  }
  for (const area of areas) {
    if (!prefixes.has(`test/${area}`)) problems.push(`test/${area}/ has no rule in ${IMPACT_MAP}: an edit to its specs must run them`)
  }
  for (const area of map.core?.areas ?? []) if (!areas.includes(area)) problems.push(`core.areas names \`${String(area)}\`, which is not an area folder of test/`)
  for (const spec of map.core?.specs ?? []) if (!specs.includes(spec)) problems.push(`core.specs names ${String(spec)}, which does not exist`)
  return problems
}

const dirsIn = (root, rel) => readdirSync(join(root, rel), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'tests').map((entry) => entry.name).sort()

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const problems = checkImpactMap({
    map: JSON.parse(readFileSync(join(root, IMPACT_MAP), 'utf8')),
    specs: listSpecs(root),
    srcDirs: dirsIn(root, 'src'),
    mainDirs: dirsIn(root, 'src/main'),
    tracked: trackedFiles(root)
  })
  if (problems.length > 0) {
    console.error(`\n${IMPACT_MAP} is out of step with the tree:\n`)
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(`${IMPACT_MAP} covers every directory under src/ and src/main/ and every e2e area.`)
}
