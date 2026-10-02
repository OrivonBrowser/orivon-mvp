// Small pieces of scaffolding duplicated across the check:* guard scripts
// (check-no-native-modules.mjs, check-contracts-pure.mjs, check-no-secrets.mjs,
// check-comments.mjs, check-size.mjs) and the launch scripts (dev.mjs,
// build-ordinary.mjs, build-e2e.mjs, run-headless.mjs, qa.mjs) --
// docs/development/code-guidelines.md Rule 3.

import { execFileSync, spawnSync } from 'node:child_process'
import { relative, sep } from 'node:path'

/**
 * True when this module was the process's entry point (`node script.mjs`),
 * false when it was only imported -- by its own test, or by another script.
 * Guards the side-effecting `if (isInvokedDirectly(...)) { ...process.exit }`
 * block every check:* script ends with, so importing one for its exported
 * function does not also run its CLI reporting and exit code.
 */
export function isInvokedDirectly (moduleUrl) {
  return process.argv[1] !== undefined &&
    moduleUrl === new URL(`file://${process.argv[1]}`).href
}

/**
 * A path relative to `root`, with forward slashes on every platform.
 * `node:path`'s `relative` uses the platform separator, and a report or an
 * error message naming a backslash path on Windows would be the one place
 * these guard scripts' output stopped being platform-neutral.
 */
export function relativeToRoot (root, full) {
  return relative(root, full).split(sep).join('/')
}

/**
 * Every path git tracks under `root`, forward-slashed and root-relative.
 *
 * Tracked files are the right scope for a guard whose subject is what reaches
 * GitHub or a reviewer: untracked scratch files and gitignored build output
 * cannot, and scanning them produces false alarms that get the guard switched
 * off.
 *
 * THROWS when `root` is not a git working tree, or `git` itself fails --
 * R-S5-04. This used to swallow every failure into `[]`, which a caller could
 * not tell apart from "nothing is tracked", and both of today's callers read
 * that as a clean scan. A guard that scans nothing must fail loudly, not pass.
 */
export function trackedFiles (root) {
  // stderr is piped, not inherited: a failing git then lands in the thrown
  // error's message (which both callers report) instead of the console of an
  // otherwise-quiet run -- the R-S5-04 negative tests run git outside a work
  // tree on purpose, and its fatal line is theirs, not the suite's.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return out.split('\0').filter(Boolean)
}

/** An argument cmd.exe passes through unchanged, so it needs no quotes. */
const CMD_PLAIN = /^[\w./\\:=@,+-]+$/

/**
 * How to spawn `command` from PATH with `args`, decided without spawning.
 *
 * On Windows, npm's shims (`npx`, `electron-vite`) are `.cmd` files, and
 * Node refuses to spawn a `.cmd` without a shell: the spawn fails with
 * EINVAL. So there the command runs through cmd.exe, as one quoted string
 * rather than a command plus an args array, which Node deprecates together
 * with `shell` (DEP0190). Elsewhere it is spawned directly, with no shell.
 * @param {string} command
 * @param {string[]} args
 * @param {string} [platform]
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
export function commandLine (command, args, platform = process.platform) {
  if (platform !== 'win32') return { file: command, args, shell: false }
  const quoted = [command, ...args].map((arg) => CMD_PLAIN.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`)
  return { file: quoted.join(' '), args: [], shell: true }
}

/**
 * `spawnSync` for a command on PATH, through `commandLine`, with stdio
 * inherited. A failure to start the command at all is printed, so a launch
 * script never exits 1 with nothing on screen.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
export function spawnCommandSync (command, args, options = {}) {
  const line = commandLine(command, args)
  const result = spawnSync(line.file, line.args, { stdio: 'inherit', ...options, shell: line.shell })
  if (result.error !== undefined) console.error(`failed to launch ${command}:`, result.error)
  return result
}
