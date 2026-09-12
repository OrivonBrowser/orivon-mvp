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
 * Set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to opt out. Nothing in this repo does:
 * the unit suite reaches Electron's own lazy downloader through
 * test/launch-electron.mjs, so a skip here only moves the download later.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
  }
}
