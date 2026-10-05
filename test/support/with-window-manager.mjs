/**
 * Starts a real window manager on the already-set `DISPLAY`, runs the given
 * command as a child, then stops it. Meant to be the command
 * `scripts/run-headless.mjs`'s `xvfb-run` wraps:
 *   node scripts/run-headless.mjs node test/support/with-window-manager.mjs <command> [args...]
 *
 * `xvfb-run` alone starts a bare X server with no window manager at all --
 * enough to render, but nothing arbitrates window stacking or hands a
 * top-level window real X input focus on a click the way a real desktop
 * does. A test asserting on native focus/blur transfer between two
 * top-level windows (an extension popup and the shell) needs a real WM
 * present on the display to mean anything; `openbox` is a small, fast one.
 *
 * Usage: node scripts/run-headless.mjs node test/support/with-window-manager.mjs <command> [args...]
 */
import { spawn, spawnSync } from 'node:child_process'

const [, , command, ...args] = process.argv
if (command === undefined) {
  console.error('usage: node test/support/with-window-manager.mjs <command> [args...]')
  process.exit(1)
}

const wm = spawn('openbox', [], { stdio: 'ignore', env: process.env })
wm.on('error', (error) => {
  console.error('[with-window-manager] failed to start openbox:', error)
})

// A fixed, short wait for the WM to take over the display before the real
// command's own windows start mapping. This is test tooling launched once
// per e2e run, not the product behaviour testing.md's "never wait for the
// clock" rule governs.
await new Promise((resolve) => setTimeout(resolve, 300))

const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })

wm.kill()

process.exit(result.status ?? 1)
