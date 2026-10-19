/**
 * Wraps a test or smoke command so it never paints on a real screen by
 * default (owner request: a build/test run must not interrupt whatever is
 * on the owner's real desktop). On Linux with xvfb-run on PATH, the wrapped
 * command runs under a fresh virtual display instead -- nothing appears on
 * screen at all. Everywhere else (no xvfb-run: macOS, Windows, or a Linux
 * box that never installed it) it runs directly; ORIVON_WINDOW_NO_FOCUS,
 * defaulted on by test/support/launch-electron.mjs for every Electron launch it
 * makes, is what keeps THAT run from stealing focus instead. See
 * docs/development/setup.md, "The no-focus switch".
 *
 * Off CI the command also gets a private D-Bus session bus, so nothing it runs
 * reaches the desktop's (a portal file picker, a notification); the child sees
 * ORIVON_E2E_PRIVATE_BUS=1. ORIVON_PRIVATE_BUS=0 keeps the desktop bus, =1 asks
 * for the private one on CI. docs/development/setup.md has the rest.
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
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly, spawnCommandSync } from './cli.mjs'

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

/** A session bus address nothing listens on. */
export const NO_BUS = 'unix:path=/nonexistent/orivon-no-session-bus'

/** The private bus's configuration: a session bus with nothing to activate. */
export const PRIVATE_BUS_CONFIG = fileURLToPath(new URL('./private-session-bus.conf', import.meta.url))

/**
 * What to spawn, decided without spawning anything.
 * @param {{ platform: string, env: Record<string, string | undefined>, has: (name: string) => boolean, command: string, args: string[] }} input
 * @returns {{ file: string, args: string[], env: Record<string, string | undefined>, virtualDisplay: boolean, privateBus: boolean } | { refused: string }}
 */
export function headlessLaunch ({ platform, env, has, command, args }) {
  const virtualDisplay = platform === 'linux' && has('xvfb-run')
  const asked = env.ORIVON_PRIVATE_BUS === '1'
  if (asked && !(virtualDisplay && has('dbus-run-session'))) {
    return { refused: 'ORIVON_PRIVATE_BUS=1 needs xvfb-run and dbus-run-session on PATH; not running on the desktop session bus' }
  }
  // A CI runner has no desktop to protect, and its specs are written against the bus it has.
  const shielded = asked || (env.ORIVON_PRIVATE_BUS !== '0' && env.CI !== 'true')
  const privateBus = shielded && virtualDisplay && has('dbus-run-session')
  // ORIVON_RUN_HEADLESS marks the child as launched here: test/support/launch-electron.mjs refuses a
  // Linux desktop launch without it, so a driver that skips this file fails instead of showing a window.
  if (!virtualDisplay) return { file: command, args, env: { ...env, ORIVON_RUN_HEADLESS: 'direct' }, virtualDisplay, privateBus }

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
  const childEnv = { ...env, ORIVON_RUN_HEADLESS: 'virtual' }
  delete childEnv.WAYLAND_DISPLAY
  if (childEnv.XDG_SESSION_TYPE === 'wayland') childEnv.XDG_SESSION_TYPE = 'x11'
  if (!privateBus) {
    // Unset, the address falls back to $XDG_RUNTIME_DIR/bus, which is the desktop's: so a dead one instead.
    if (shielded) childEnv.DBUS_SESSION_BUS_ADDRESS = NO_BUS
    return { file: 'xvfb-run', args: ['-a', command, ...args], env: childEnv, virtualDisplay, privateBus }
  }

  // Inside xvfb-run, so the bus daemon inherits the virtual display rather
  // than the desktop's. The desktop bus's address is dropped too:
  // dbus-run-session replaces it, and nothing may fall back. Its config starts
  // no service on demand (private-session-bus.conf says why).
  delete childEnv.DBUS_SESSION_BUS_ADDRESS
  childEnv.ORIVON_E2E_PRIVATE_BUS = '1'
  return { file: 'xvfb-run', args: ['-a', 'dbus-run-session', `--config-file=${PRIVATE_BUS_CONFIG}`, '--', command, ...args], env: childEnv, virtualDisplay, privateBus }
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
  const bus = launch.privateBus ? ' and a private session bus' : launch.env.DBUS_SESSION_BUS_ADDRESS === NO_BUS ? ' and no session bus' : ''
  console.error(launch.virtualDisplay
    ? `[run-headless] using a virtual display (xvfb-run, Wayland stripped from the child env)${bus}`
    : '[run-headless] no virtual display available -- running directly, relying on ORIVON_WINDOW_NO_FOCUS')
  const result = spawnCommandSync(launch.file, launch.args, { env: launch.env })
  process.exit(result.error === undefined ? result.status ?? 1 : 1)
}
