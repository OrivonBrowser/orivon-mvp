/**
 * Starts Orivon from this checkout the way a desktop launcher does, and writes the Linux desktop entry that calls it.
 * A start while anything runs this checkout's Electron goes straight to it, and a browser already open takes the
 * request and the start exits; only a start with nothing running builds first. A dock click then never waits for a
 * build, never rewrites `out/` under a running browser (a profile or a private session included), and its switches
 * (`--new-window`, `--new-private-window`) reach the browser, which `electron-vite preview` would drop.
 *
 * The entry is `orivon-source.desktop`, never `orivon.desktop`: that name is the installed package's (ADR-0057), and
 * a file of that name in the user's own directory would hide the package's entry, its actions and its default choice.
 *
 *   node scripts/launch-from-source.mjs run [switches and addresses...]
 *   node scripts/launch-from-source.mjs install    writes ~/.local/share/applications/orivon-source.desktop
 *   node scripts/launch-from-source.mjs remove
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = fileURLToPath(import.meta.url)

/**
 * Whether a process runs `binary`, read from Linux's `/proc`. Each checkout has its own Electron binary, so this is
 * every Orivon of this checkout: the default profile, another profile, a private session. False where there is no `/proc`.
 * @param {string} binary
 * @param {{ pids?: () => string[], exeOf?: (pid: string) => string }} [seams]
 */
export function isRunning (binary, { pids = () => readdirSync('/proc'), exeOf = (pid) => readlinkSync(`/proc/${pid}/exe`) } = {}) {
  let listed
  try {
    listed = pids().filter((name) => /^\d+$/.test(name))
  } catch {
    return false
  }
  return listed.some((pid) => {
    try {
      return exeOf(pid).replace(/ \(deleted\)$/, '') === binary
    } catch {
      return false
    }
  })
}

/** `$XDG_DATA_HOME` when it is an absolute path (the specification says to ignore any other), else `~/.local/share`:
 * the rule the browser reads the entry back with (`src/main/os/site-shortcut-runner.ts`). */
export const dataHome = (env, home) => isAbsolute(env.XDG_DATA_HOME ?? '') ? env.XDG_DATA_HOME : join(home, '.local', 'share')

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

const entryPath = (env, home, name) => join(dataHome(env, home), 'applications', name)

function run (args) {
  // A launcher's PATH may not reach this Node, which the build's npx needs; and a shell's ELECTRON_RUN_AS_NODE would
  // turn Electron into plain Node.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  if (!isRunning(realpathSync(electron))) {
    const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-ordinary.mjs')], { cwd: ROOT, env, stdio: 'inherit' })
    if (built.status !== 0) process.exit(built.status ?? 1)
  }
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
