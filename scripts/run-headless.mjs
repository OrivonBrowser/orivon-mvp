/**
 * Wraps a test/smoke command so it never paints on a real screen by
 * default (owner request: a build/test run must not interrupt whatever is
 * on the owner's real desktop). On Linux with xvfb-run on PATH, the wrapped
 * command runs under a fresh virtual display instead -- nothing appears on
 * screen at all. Everywhere else (no xvfb-run: macOS, Windows, or a Linux
 * box that never installed it) it runs directly; ORIVON_WINDOW_NO_FOCUS,
 * defaulted on by test/launch-electron.mjs for every Electron launch it
 * makes, is what keeps THAT run from stealing focus instead. See
 * docs/development/setup.md, "The no-focus switch".
 *
 * ORIVON_PRIVATE_BUS=1 also gives the command a D-Bus session bus of its
 * own, so nothing it runs can reach the desktop's notification daemon; the
 * child sees ORIVON_E2E_PRIVATE_BUS=1. Opt-in, and refused where it cannot
 * be had rather than run on the desktop bus.
 *
 * If xvfb-run IS available but fails to run the wrapped command (not the
 * wrapped command's own non-zero exit -- a spawn-level failure, e.g. the
 * binary vanished between the PATH check and use), this fails loudly rather
 * than silently retrying on the real display.
 *
 * Usage: node scripts/run-headless.mjs <command> [args...]
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isInvokedDirectly } from './cli.mjs'

/**
 * True if `name` resolves to an executable file on PATH -- checked directly
 * rather than by spawning it, so a probe never starts a real Xvfb server.
 * @param {string} name
 * @returns {boolean}
 */
function commandExists (name) {
  const dirs = (process.env.PATH ?? '').split(delimiter)
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * What to spawn, decided without spawning anything.
 * @param {{ platform: string, env: Record<string, string | undefined>, has: (name: string) => boolean, command: string, args: string[] }} input
 * @returns {{ file: string, args: string[], env: Record<string, string | undefined>, virtualDisplay: boolean, privateBus: boolean } | { refused: string }}
 */
export function headlessLaunch ({ platform, env, has, command, args }) {
  // npm's own Windows .cmd shim needs its exact name when spawned without a
  // shell (same reasoning as build-e2e.mjs's npx.cmd) -- xvfb-run is
  // Linux-only, so this only matters on the direct-run path below.
  const resolved = platform === 'win32' && command === 'npx' ? 'npx.cmd' : command
  const virtualDisplay = platform === 'linux' && has('xvfb-run')
  const privateBus = env.ORIVON_PRIVATE_BUS === '1'
  if (privateBus && !(virtualDisplay && has('dbus-run-session'))) {
    return { refused: 'ORIVON_PRIVATE_BUS=1 needs xvfb-run and dbus-run-session on PATH; not running on the desktop session bus' }
  }
  if (!virtualDisplay) return { file: resolved, args, env, virtualDisplay, privateBus }

  // XVFB-RUN ALONE IS NOT ENOUGH ON A WAYLAND DESKTOP, and this is the whole
  // reason this block exists. `xvfb-run` creates an X server and sets DISPLAY.
  // Electron's ozone layer auto-detects, sees WAYLAND_DISPLAY still inherited
  // from the session, and connects to the REAL compositor -- so the window
  // opens on the owner's actual desktop, stealing focus mid-typing, while the
  // virtual display sits unused and the log still says "using a virtual
  // display". Removing WAYLAND_DISPLAY (and the session-type hint that also
  // selects it) leaves X11 as the only option ozone can find, which is the
  // one xvfb-run just pointed at the virtual display.
  //
  // Deliberately NOT `--ozone-platform=x11`: src/main/index.ts's own header
  // warns that forcing it there crashes the GPU process. This changes only
  // what the child can DISCOVER, never what the app asks for, so the app's
  // normal launch on a real desktop is untouched.
  const childEnv = { ...env }
  delete childEnv.WAYLAND_DISPLAY
  if (childEnv.XDG_SESSION_TYPE === 'wayland') childEnv.XDG_SESSION_TYPE = 'x11'
  if (!privateBus) return { file: 'xvfb-run', args: ['-a', resolved, ...args], env: childEnv, virtualDisplay, privateBus }

  // Inside xvfb-run, so the bus daemon, and any service it starts, inherits
  // the virtual display rather than the desktop's. The desktop bus's address
  // is dropped too: dbus-run-session replaces it, and nothing may fall back.
  delete childEnv.DBUS_SESSION_BUS_ADDRESS
  childEnv.ORIVON_E2E_PRIVATE_BUS = '1'
  return { file: 'xvfb-run', args: ['-a', 'dbus-run-session', '--', resolved, ...args], env: childEnv, virtualDisplay, privateBus }
}

if (isInvokedDirectly(import.meta.url)) {
  const [, , command, ...args] = process.argv
  if (command === undefined) {
    console.error('usage: node scripts/run-headless.mjs <command> [args...]')
    process.exit(1)
  }
  const launch = headlessLaunch({ platform: process.platform, env: process.env, has: commandExists, command, args })
  if ('refused' in launch) {
    console.error(`[run-headless] ${launch.refused}`)
    process.exit(1)
  }
  console.error(launch.virtualDisplay
    ? `[run-headless] using a virtual display (xvfb-run, Wayland stripped from the child env)${launch.privateBus ? ' and a private session bus' : ''}`
    : '[run-headless] no virtual display available -- running directly, relying on ORIVON_WINDOW_NO_FOCUS')
  const result = spawnSync(launch.file, launch.args, { stdio: 'inherit', env: launch.env })
  if (result.error !== undefined) {
    console.error(`[run-headless] failed to launch ${launch.file}:`, result.error)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}
