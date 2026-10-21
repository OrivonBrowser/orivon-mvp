/**
 * Says whether a branch changes the Electron it ships: the `electron` range in package.json or the version
 * package-lock.json resolves it to. CI runs the uBlock Origin spec as a required check when it does
 * (docs/development/testing.md section Electron upgrades), because an upgrade is what silently breaks the
 * blocking webRequest bridge the extension needs.
 *
 *   node scripts/ci/electron-version-changed.mjs --base origin/main
 *
 * Prints `changed=true` or `changed=false` (and appends the same line to $GITHUB_OUTPUT). A base that cannot be
 * read counts as changed: the gate then runs where it might have been skipped. Imports `node:*` only.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { isInvokedDirectly } from '../cli.mjs'

/**
 * The Electron a package.json asks for and a package-lock.json resolves; undefined for a file that does not
 * say, so a missing lock never reads as an upgrade by itself.
 *
 * @param {string | undefined} packageJson
 * @param {string | undefined} lockJson
 * @returns {{ range: string | undefined, resolved: string | undefined }}
 */
export function electronVersions(packageJson, lockJson) {
  const read = (text) => { try { return text === undefined ? undefined : JSON.parse(text) } catch { return undefined } }
  const pkg = read(packageJson)
  const lock = read(lockJson)
  const range = pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron
  return {
    range: typeof range === 'string' ? range : undefined,
    resolved: typeof lock?.packages?.['node_modules/electron']?.version === 'string' ? lock.packages['node_modules/electron'].version : undefined
  }
}

/**
 * @param {{ packageJson?: string, lockJson?: string }} base
 * @param {{ packageJson?: string, lockJson?: string }} head
 */
export function electronChanged(base, head) {
  const before = electronVersions(base.packageJson, base.lockJson)
  const after = electronVersions(head.packageJson, head.lockJson)
  return before.range !== after.range || before.resolved !== after.resolved
}

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

function main() {
  const at = process.argv.indexOf('--base')
  const base = at === -1 ? undefined : process.argv[at + 1]
  if (base === undefined) throw new Error('--base <ref> is required')
  const basePackage = gitShow(base, 'package.json')
  const changed = basePackage === undefined || electronChanged(
    { packageJson: basePackage, lockJson: gitShow(base, 'package-lock.json') },
    { packageJson: readFileSync('package.json', 'utf8'), lockJson: readFileSync('package-lock.json', 'utf8') }
  )
  const line = `changed=${String(changed)}`
  console.log(line)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
}

if (isInvokedDirectly(import.meta.url)) main()
