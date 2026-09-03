// Small pieces of scaffolding duplicated across the check:* guard scripts
// (check-no-native-modules.mjs, check-contracts-pure.mjs, check-no-secrets.mjs,
// check-comments.mjs, check-size.mjs) -- docs/development/code-guidelines.md Rule 3.

import { execFileSync } from 'node:child_process'
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
 * off. Returns [] outside a git repository -- nothing is tracked, so there is
 * nothing to check.
 */
export function trackedFiles (root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return []
  }
}
