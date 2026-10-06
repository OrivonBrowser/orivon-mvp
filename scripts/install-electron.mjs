/**
 * Fetches Electron's binary during `npm install`.
 *
 * Electron 44 dropped its own postinstall hook: `npm install` now brings down
 * the JS wrapper alone, and the ~280 MB binary arrives lazily, on the first
 * `require('electron')`. electron-vite never makes that call -- it reads
 * `node_modules/electron/path.txt` itself and throws `Electron uninstall` when
 * the file is absent -- so on a fresh clone `npm run dev` and `npm run start`
 * both fail before a window is ever opened, naming neither the cause nor the
 * cure. Running the installer here puts the download back where a contributor
 * already expects it, and keeps it idempotent: electron's own install.js exits
 * early once the binary matches the installed version.
 *
 * The same hook then sets the binary's fuses that a package sets and a run from source
 * depends on (`setCheckoutFuses`): the file-protocol fuse off (ADR-0059) and cookie
 * encryption on.
 *
 * Set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to opt out. Nothing in this repo does:
 * the unit suite reaches Electron's own lazy downloader through
 * test/support/launch-electron.mjs, so a skip here only moves the download later.
 */
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const SKIP = 'ELECTRON_SKIP_BINARY_DOWNLOAD'

/**
 * Where electron's own installer lives, or `undefined` when the package is not
 * there to be found. Resolved rather than hardcoded to `node_modules/electron/`
 * because a worktree reaches its dependencies through a symlink
 * (`parallel-work.md`), and a hoisted or nested layout puts it elsewhere again.
 *
 * @param {string} [from] Module URL to resolve relative to.
 * @returns {string | undefined}
 */
export function resolveInstaller (from = import.meta.url) {
  try {
    return createRequire(from).resolve('electron/install.js')
  } catch {
    return undefined
  }
}

/**
 * What this hook should do, decided without doing any of it.
 *
 * @param {Record<string, string | undefined>} env Environment to read.
 * @param {(from?: string) => string | undefined} [resolve] Installer lookup.
 * @returns {{ action: 'skip' | 'absent' | 'install', installer?: string }}
 *   `absent` is a success: `npm install --omit=dev` reaches this hook too, and
 *   electron is a devDependency.
 */
export function electronInstallPlan (env, resolve = resolveInstaller) {
  if (env[SKIP]) return { action: 'skip' }

  const installer = resolve()
  if (installer === undefined) return { action: 'absent' }

  return { action: 'install', installer }
}

/**
 * The Electron executable the installer put in place, or `undefined` when `path.txt` is missing.
 *
 * @param {string} installer Path of electron's `install.js`.
 * @returns {string | undefined}
 */
export function electronBinaryPath (installer) {
  const base = dirname(installer)
  try {
    const relative = readFileSync(join(base, 'path.txt'), 'utf8').trim()
    return relative === '' ? undefined : join(base, 'dist', relative)
  } catch {
    return undefined
  }
}

/**
 * The fuses a checkout's binary takes from a package, by their `electron-builder.yml` names. With the
 * file-protocol fuse off, a `file:` page gets no more reach than a web page does (ADR-0059). With cookie
 * encryption on, the cookie store is written as a package writes it: a run from source and an installed
 * package share one profile (ADR-0057), and a binary without the fuse reads none of the cookies the other
 * encrypted, so every site the package was signed in to is signed out.
 */
export const CHECKOUT_FUSES = Object.freeze({ grantFileProtocolExtraPrivileges: false, enableCookieEncryption: true })

/** A fuse's state byte in the wire: ASCII '1' and '0'. */
const ON = 49
const OFF = 48

/** The wire index of a fuse named as `electron-builder.yml` names it (`FuseV1Options` capitalises the first letter). */
const indexOf = (FuseV1Options, name) => FuseV1Options[name[0].toUpperCase() + name.slice(1)]

async function flipWithFuses (path) {
  const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses')
  const config = { version: FuseVersion.V1 }
  for (const [name, on] of Object.entries(CHECKOUT_FUSES)) config[indexOf(FuseV1Options, name)] = on
  await flipFuses(path, config)
}

async function fusesMatch (path) {
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses')
  const wire = await getCurrentFuseWire(path)
  return Object.entries(CHECKOUT_FUSES).every(([name, on]) => wire[indexOf(FuseV1Options, name)] === (on ? ON : OFF))
}

/**
 * Sets the binary's `CHECKOUT_FUSES`, writing a new file and renaming it over `binary`: a worktree's
 * `node_modules` is a hard-linked copy of another checkout's, so a write in place would change that
 * checkout's binary too (and fail with ETXTBSY while it runs). Only Linux is flipped: macOS and
 * Windows are refused until the flip is measured there (docs/open-questions.md A394).
 *
 * @param {object} options
 * @param {string} options.binary The Electron executable.
 * @param {string} options.checkoutRoot The checkout this script belongs to; a binary outside it is refused.
 * @param {NodeJS.Platform} [options.platform]
 * @param {(path: string) => Promise<void>} [options.flip] Sets the fuses in the file at `path`.
 * @param {(path: string) => Promise<boolean>} [options.match] Whether the file at `path` has them set already.
 * @returns {Promise<{ status: 'already-set' | 'flipped' | 'refused' | 'failed', reason?: string }>}
 */
export async function setCheckoutFuses ({
  binary, checkoutRoot, platform = process.platform, flip = flipWithFuses, match = fusesMatch
}) {
  if (platform !== 'linux') {
    return { status: 'refused', reason: `the flip is not measured on ${platform} yet (A394)` }
  }
  const file = binary
  const tmp = `${binary}.fuse-tmp`
  try {
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(checkoutRoot)])
    if (!realFile.startsWith(realRoot + sep)) {
      return {
        status: 'refused',
        reason: `the Electron binary is outside this checkout (${realFile}); flipping it would change a binary other checkouts share`
      }
    }
    if (await match(file)) return { status: 'already-set' }

    const before = await stat(file)
    try {
      await copyFile(file, tmp)
      await chmod(tmp, before.mode & 0o7777)
      await flip(tmp)
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    if ((await stat(file)).ino === before.ino) {
      return { status: 'failed', reason: 'the binary kept its inode, so it was not replaced' }
    }
    return { status: 'flipped' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const plan = electronInstallPlan(process.env)

  if (plan.action === 'skip') {
    console.log(`Electron binary: not fetched, ${SKIP} is set.`)
  } else if (plan.action === 'absent') {
    console.log('Electron binary: not fetched, the electron package is not installed.')
  } else {
    const { status } = spawnSync(process.execPath, [plan.installer], { stdio: 'inherit' })

    if (status !== 0) {
      console.error(
        "\nElectron's binary did not install, so `npm run dev` and `npm run start`" +
        '\nwill fail with "Electron uninstall". Re-run it on its own with' +
        `\n\`npm run install:electron\`, or set ${SKIP}=1 if this machine never` +
        '\nneeds to launch the app.\n'
      )
      process.exit(1)
    }

    console.log('Electron binary: ready.')

    const binary = electronBinaryPath(plan.installer)
    if (binary !== undefined) {
      const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const { status, reason } = await setCheckoutFuses({ binary, checkoutRoot })
      if (status === 'refused' || status === 'failed') {
        const until = status === 'failed' ? 'until `npm run install:electron` sets them' : 'until the reason above no longer holds'
        console.warn(`\nElectron binary: the fuses stay as Electron ships them (${reason}).\nA run from this checkout opens no local files and reads none of the cookies a package wrote to a shared profile, ${until}.\n`)
      } else {
        console.log(`Electron binary: fuses set as a package sets them (${status}).`)
      }
    }
  }
}
