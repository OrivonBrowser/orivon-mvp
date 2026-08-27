// Two small pieces of scaffolding duplicated across the check:* guard
// scripts (check-no-native-modules.mjs, check-contracts-pure.mjs, check-no-
// secrets.mjs) -- docs/development/code-guidelines.md Rule 3.

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
