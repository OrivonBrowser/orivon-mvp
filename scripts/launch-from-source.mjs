/**
 * Starts Orivon from this checkout the way a desktop launcher does, and writes the Linux desktop entry that calls it.
 * A start while Orivon is open goes straight to Electron, which hands the request to the open browser and exits;
 * only a start with nothing open builds first. A dock click then never waits for a build, never rewrites `out/`
 * under a running browser, and its switches (`--new-window`, `--new-private-window`) reach the browser, which
 * `electron-vite preview` would drop.
 *
 * The entry is `orivon-source.desktop`, never `orivon.desktop`: that name is the installed package's (ADR-0057), and
 * a file of that name in the user's own directory would hide the package's entry, its actions and its default choice.
 *
 *   node scripts/launch-from-source.mjs run [switches and addresses...]
 *   node scripts/launch-from-source.mjs install    writes ~/.local/share/applications/orivon-source.desktop
 *   node scripts/launch-from-source.mjs remove
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = fileURLToPath(import.meta.url)
const USER_DATA_DIR = '--user-data-dir='

/** The pid a Chromium `SingletonLock` link (`<host>-<pid>`) names, when it is this host's; null otherwise. */
export function lockPid (target, host) {
  const at = target.lastIndexOf('-')
  if (at <= 0 || target.slice(0, at) !== host) return null
  const pid = Number(target.slice(at + 1))
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** The data directory the start will lock: the one `--user-data-dir=` names, else Electron's default on Linux. */
export function userDataDir (args, env, home, appName) {
  for (const arg of args) {
    if (arg === '--') break
    if (arg.startsWith(USER_DATA_DIR)) return arg.slice(USER_DATA_DIR.length)
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), appName)
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Whether a browser holds the directory's lock. A crash leaves the link behind, so its process must still be alive.
 * @param {string} dir
 * @param {{ readLink?: (path: string) => string, host?: string, alive?: (pid: number) => boolean }} [seams]
 */
export function isOpen (dir, { readLink = (path) => readlinkSync(path), host = hostname(), alive = isAlive } = {}) {
  let target
  try {
    target = readLink(join(dir, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = lockPid(target, host)
  return pid !== null && alive(pid)
}

/** A path the entry can name unquoted: the Desktop Entry Specification reserves these characters, and `xdg-settings`
 * takes the program as `Exec`'s first word, quotes and all, so a quoted one would name no program. */
const PLAIN_PATH = /^[^\s"'`$\\%<>~|&;*?#()\u0000-\u001f\u007f]+$/

/** The installed package's types (`electron-builder.yml`). `xdg-settings` rewrites a local entry that lacks the type
 * it registers, putting the line after the action groups. */
const MIME_TYPES = 'text/html;application/xhtml+xml;image/svg+xml;application/pdf;x-scheme-handler/http;x-scheme-handler/https;'

/** The desktop entry for this checkout. The action ids and names are the installed package's (`electron-builder.yml`). */
export function desktopEntry (node, script, root) {
  const unplain = [node, script, root].find((path) => !PLAIN_PATH.test(path))
  if (unplain !== undefined) throw new Error(`a desktop entry cannot name ${JSON.stringify(unplain)}: move it to a path without spaces, quotes or shell characters`)
  const exec = (...args) => `Exec=${node} ${script} run ${args.join(' ')}`
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orivon (source)',
    exec('%U'),
    `Icon=${join(root, 'build', 'icon.png')}`,
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    'StartupWMClass=orivon',
    `MimeType=${MIME_TYPES}`,
    'Actions=new-window;new-private-window;',
    '',
    '[Desktop Action new-window]',
    'Name=New Window',
    exec('--new-window'),
    '',
    '[Desktop Action new-private-window]',
    'Name=New Private Window',
    exec('--new-private-window'),
    ''
  ].join('\n')
}

const entryPath = (env, home, name) => join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications', name)

function run (args) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // A launcher's PATH may not reach this Node, which the build's npx needs; and a shell's ELECTRON_RUN_AS_NODE would
  // turn Electron into plain Node.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  delete env.ELECTRON_RUN_AS_NODE
  if (!isOpen(userDataDir(args, env, homedir(), pkg.productName ?? pkg.name))) {
    const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-ordinary.mjs')], { cwd: ROOT, env, stdio: 'inherit' })
    if (built.status !== 0) process.exit(built.status ?? 1)
  }
  const electron = createRequire(import.meta.url)('electron')
  const child = spawn(electron, [ROOT, ...args], { env, stdio: 'inherit' })
  child.on('close', (code) => { process.exit(code ?? 1) })
}

if (isInvokedDirectly(import.meta.url)) {
  const [, , command, ...args] = process.argv
  const path = entryPath(process.env, homedir(), 'orivon-source.desktop')
  if (command === 'run') {
    run(args)
  } else if ((command === 'install' || command === 'remove') && process.platform !== 'linux') {
    console.error('[launch-from-source] the desktop entry is a Linux one')
    process.exit(1)
  } else if (command === 'install') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, desktopEntry(process.execPath, SCRIPT, ROOT))
    console.log(`[launch-from-source] wrote ${path}`)
    const hiding = entryPath(process.env, homedir(), 'orivon.desktop')
    if (existsSync(hiding)) console.warn(`[launch-from-source] ${hiding} hides the installed package's entry; remove it`)
  } else if (command === 'remove') {
    // An entry this script did not write is someone else's.
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(SCRIPT)) {
      console.error(`[launch-from-source] ${path} does not start this checkout; left in place`)
      process.exit(1)
    }
    rmSync(path, { force: true })
    console.log(`[launch-from-source] removed ${path}`)
  } else {
    console.error('usage: node scripts/launch-from-source.mjs run [args...] | install | remove')
    process.exit(1)
  }
}
