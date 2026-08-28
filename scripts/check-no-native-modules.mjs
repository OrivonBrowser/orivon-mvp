/**
 * Fails the build if any native build artefact appears under node_modules.
 *
 * Rule 8 (CLAUDE.md) and build-plan.md SS Platform policy: Windows and macOS
 * are supported from day one via run-from-source. A dependency that needs
 * node-gyp, CMake or a C++ toolchain turns `npm install` into a worse wall
 * than the code-signing certificate it was meant to avoid.
 *
 * The concrete threat is not hypothetical. webtorrent reaches node-datachannel
 * through `@thaunknown/simple-peer -> webrtc-polyfill`, and node-datachannel
 * builds with cmake-js. That chain is hard, not optional, which is why
 * webtorrent ships as a pre-built app asset rather than a shell dependency.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

/**
 * What actually breaks run-from-source is a package that must COMPILE at
 * install time. A package that merely ships a prebuilt `.node` for every
 * platform is the cure for that problem, not a case of it -- and flagging
 * those would fail on Electron's own dependencies, so the guard would be
 * turned off within a day and protect nothing.
 *
 * Measured on this tree 2026-08-25: `@electron-internal/extract-zip`,
 * `@rollup/rollup-linux-x64-gnu` and `@swc/core-linux-x64-gnu` all ship
 * prebuilt binaries with no build step. All three are fine.
 */

/** Directory names that mean "a compiled artefact lives here". */
const ARTEFACT_DIRS = new Set(['prebuilds'])

/** File names that mean "this package compiles native code". */
const ARTEFACT_FILES = new Set(['binding.gyp'])

/** Build tools that, named in an install script, mean a compiler is required. */
const BUILD_TOOLS = /\b(node-gyp|cmake-js|prebuild-install|node-pre-gyp|neon|cargo|gyp)\b/

/** Loadable native binaries. Reported for visibility; NOT a failure. */
const NATIVE_BINARY = /\.node$/

/**
 * @param {string} root Directory containing the node_modules tree to check.
 * @returns {{ ok: boolean, offenders: string[], prebuilt: string[] }}
 *   `offenders` fail the build; `prebuilt` is informational. Both are
 *   root-relative, sorted, and use forward slashes so output is stable
 *   across platforms.
 */
export function checkNoNativeModules (root) {
  const modulesRoot = join(root, 'node_modules')
  const empty = { ok: true, offenders: [], prebuilt: [] }
  try {
    if (!statSync(modulesRoot).isDirectory()) return empty
  } catch {
    return empty
  }

  const offenders = []
  const prebuilt = []
  walk(modulesRoot)
  offenders.sort()
  prebuilt.sort()
  return { ok: offenders.length === 0, offenders, prebuilt }

  function walk (dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: not our failure to report
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)

      // Never traverse a symlink. Dirent reflects lstat, so isDirectory() is
      // already false for one -- but a package may symlink outside the tree
      // (or to itself), and following either would produce a false positive
      // or an unbounded walk.
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (ARTEFACT_DIRS.has(entry.name)) offenders.push(relativeToRoot(root, full))
        else walk(full)
        continue
      }

      if (ARTEFACT_FILES.has(entry.name)) {
        offenders.push(relativeToRoot(root, full))
      } else if (entry.name === 'package.json') {
        if (declaresBuildStep(full)) offenders.push(relativeToRoot(root, full))
      } else if (NATIVE_BINARY.test(entry.name)) {
        prebuilt.push(relativeToRoot(root, full))
      }
    }
  }

  /** True if an install hook invokes a compiler toolchain. */
  function declaresBuildStep (packageJsonPath) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    } catch {
      return false
    }
    const scripts = manifest?.scripts
    if (typeof scripts !== 'object' || scripts === null) return false
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      const command = scripts[hook]
      if (typeof command === 'string' && BUILD_TOOLS.test(command)) return true
    }
    return false
  }

}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, offenders, prebuilt } = checkNoNativeModules(process.cwd())

  if (!ok) {
    console.error('\nDependencies requiring a compiler found under node_modules:\n')
    for (const offender of offenders) console.error(`  ${offender}`)
    console.error(
      '\nRule 8 forbids these. They break run-from-source on Windows and macOS,' +
      '\nwhich build-plan.md makes a supported path. If a dependency needs them,' +
      '\nship it as a pre-built app asset instead of a shell dependency.\n'
    )
    process.exit(1)
  }

  const packages = new Set(prebuilt.map((p) => p.split('/').slice(0, 2).join('/')))
  console.log(
    `Rule 8 satisfied: nothing under node_modules requires a compiler.` +
    (packages.size > 0
      ? `\n  ${packages.size} package(s) ship prebuilt binaries, which is fine: ` +
        `${[...packages].join(', ')}`
      : '')
  )
}
