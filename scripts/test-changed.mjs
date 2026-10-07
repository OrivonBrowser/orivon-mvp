#!/usr/bin/env node
// Runs the unit tests a change can affect, not the whole suite, which CI runs on every pull request.
// The change is every file that differs from the merge base with --base (default origin/main),
// committed or not, plus untracked files. A code file brings the tests that import it (vitest
// related); any other file brings the tests that name it, since a test reads a fixture or a
// document through the filesystem, not an import. A change to what every test runs under (the
// dependencies, the lockfile, a tsconfig, the vitest config) runs everything, as does --all.
//
//   npm run test:changed [-- --base <ref>] [-- --all] [-- --dry]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_RUN = [/^package(-lock)?\.json$/, /^tsconfig[^/]*\.json$/, /^vitest\.config\.[cm]?[jt]s$/]
const CODE = /\.(?:[cm]?[jt]s|tsx|json)$/
const UNIT_TESTS = ['src/**/*.test.ts', 'scripts/**/*.test.ts']

/**
 * What to run for a set of changed paths, repo-relative. `named` returns the unit test files that
 * mention a path's file name. Pure apart from that callback.
 * @param {readonly string[]} changed
 * @param {(name: string) => string[]} named
 * @returns {{ mode: 'full', reason: string } | { mode: 'related', files: string[] } | { mode: 'none' }}
 */
export function planTestRun (changed, named) {
  const trigger = changed.find((path) => FULL_RUN.some((pattern) => pattern.test(path)))
  if (trigger !== undefined) return { mode: 'full', reason: `${trigger} changed` }
  const files = new Set()
  for (const path of changed) {
    if (CODE.test(path)) files.add(path)
    else for (const test of named(basename(path))) files.add(test)
  }
  return files.size === 0 ? { mode: 'none' } : { mode: 'related', files: [...files].sort() }
}

function git (...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter((line) => line !== '')
}

/** Whether package.json's dependencies differ from the merge base: a new script alone changes no test. */
function dependenciesChanged (mergeBase) {
  const pick = (text) => { const pkg = JSON.parse(text); return JSON.stringify([pkg.type, pkg.dependencies, pkg.devDependencies, pkg.overrides]) }
  try {
    return pick(execFileSync('git', ['show', `${mergeBase}:package.json`], { encoding: 'utf8' })) !== pick(readFileSync('package.json', 'utf8'))
  } catch {
    return true
  }
}

function changedPaths (base) {
  const [mergeBase] = git('merge-base', base, 'HEAD')
  const paths = new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])
  if (paths.has('package.json') && !dependenciesChanged(mergeBase)) paths.delete('package.json')
  // A deleted file has no tests left to run; the tests that imported it changed too, or fail in CI.
  return [...paths].filter((path) => existsSync(path))
}

function namedBy (name) {
  try {
    return git('grep', '-l', '-F', name, '--', ...UNIT_TESTS)
  } catch {
    return [] // git grep exits 1 when nothing matches.
  }
}

function main (argv) {
  const at = argv.indexOf('--base')
  const base = at === -1 ? 'origin/main' : argv[at + 1]
  const plan = argv.includes('--all') ? { mode: 'full', reason: '--all' } : planTestRun(changedPaths(base), namedBy)
  if (plan.mode === 'none') {
    console.log(`test:changed: nothing a unit test covers differs from ${base}.`)
    return 0
  }
  const args = plan.mode === 'full'
    ? ['vitest', 'run', '--maxWorkers=2']
    : ['vitest', 'related', '--run', '--passWithNoTests', '--maxWorkers=2', ...plan.files]
  console.log(plan.mode === 'full' ? `test:changed: whole suite (${plan.reason}).` : `test:changed: tests related to ${String(plan.files.length)} changed files against ${base}.`)
  if (argv.includes('--dry')) {
    console.log(['npx', ...args].join(' '))
    return 0
  }
  return spawnSync('npx', args, { stdio: 'inherit' }).status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
