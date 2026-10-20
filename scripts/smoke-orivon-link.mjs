/**
 * Whether an installed package is registered with the system as a browser and as the handler of `orivon:` links,
 * and whether a link handed to the system reaches the running app. The release workflow runs it after it
 * installs the NSIS package on Windows and the dmg's app on macOS.
 *
 * Usage: node scripts/smoke-orivon-link.mjs <executable> [<app bundle>]
 *
 * It prints one line per check and exits 1 when any failed. The app it starts uses the default profile, because a
 * link the system starts carries no profile switch; the runner is throwaway.
 */
import { spawn, spawnSync } from 'node:child_process'
import { isInvokedDirectly } from './cli.mjs'
import { devToolsPort, evaluate, shellTarget, stop, waitForShell } from './smoke-packaged.mjs'

const NAME = 'orivon-link-smoke.eth'
export const LINK = `orivon:open?u=${NAME}/page`
export const REFUSED_LINK = 'orivon:open?u=https://example.com/refused'
const OPENED_ADDRESS = `https://${NAME}/page`
const STARTUP_TIMEOUT_MS = 300_000
const REACH_TIMEOUT_MS = 60_000
const REFUSAL_SETTLE_MS = 8_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[smoke-orivon-link] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`)
}

const run = (command, args, env) => spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 })

/** The value of `name` (`''` for the key's default) in the output of `reg query`; undefined when it is not listed. An empty string value is `''`. */
export function registryValue (output, name) {
  const wanted = name === '' ? '(default)' : name.toLowerCase()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s{4}(.+?)\s{4}REG_\w+(?:\s{4}(.*))?$/.exec(line)
    if (match !== null && match[1].toLowerCase() === wanted) return (match[2] ?? '').trim()
  }
  return undefined
}

function windowsRegistration () {
  const read = (key, name) => {
    for (const hive of ['HKCU', 'HKLM']) {
      const out = run('reg', ['query', `${hive}\\${key}`, ...(name === '' ? ['/ve'] : ['/v', name])])
      const value = out.status === 0 ? registryValue(out.stdout, name) : undefined
      if (value !== undefined) return value
    }
    return undefined
  }
  const registered = read('Software\\RegisteredApplications', 'Orivon')
  record('Windows lists Orivon as a browser (RegisteredApplications)', registered !== undefined, registered)
  record('Software\\Clients\\StartMenuInternet\\Orivon exists', read('Software\\Clients\\StartMenuInternet\\Orivon', '') === 'Orivon')
  for (const scheme of ['http', 'https']) {
    record(`the browser capabilities claim ${scheme}`, read('Software\\Clients\\StartMenuInternet\\Orivon\\Capabilities\\URLAssociations', scheme) === 'OrivonURL')
  }
  record('the orivon URL class is a URL protocol', read('Software\\Classes\\orivon', 'URL Protocol') === '')
  const command = read('Software\\Classes\\orivon\\shell\\open\\command', '')
  record('the orivon URL class has its command', command !== undefined && /Orivon\.exe"\s+--\s+"%1"$/i.test(command), command)
}

function macRegistration (bundle) {
  const plist = run('plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', `${bundle}/Contents/Info.plist`])
  const declared = plist.status === 0 ? JSON.parse(plist.stdout).flatMap((type) => type.CFBundleURLSchemes ?? []) : []
  for (const scheme of ['http', 'https', 'orivon']) record(`Info.plist declares ${scheme}`, declared.includes(scheme), declared.join(','))
  // What Finder does when a person puts an app in Applications.
  const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  run(register, ['-f', bundle])
  // Printed for the record; the checks below ask LaunchServices through the API a program uses.
  const dump = run(register, ['-dump']).stdout ?? ''
  console.log(`[smoke-orivon-link] LaunchServices dump, lines naming orivon:\n${dump.split('\n').filter((line) => /orivon/i.test(line)).slice(0, 30).join('\n')}`)
  const jxa = (scheme) => run('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.URLWithString('${scheme}:open?u=a.eth')); var out = []; for (var i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path)); out.join('\\n')`]).stdout ?? ''
  for (const scheme of ['http', 'https', 'orivon']) {
    const apps = jxa(scheme).split('\n')
    record(`LaunchServices lists the app for ${scheme}`, apps.some((path) => path.startsWith(bundle)), apps.join(' | '))
  }
}

/** Hands `link` to the system, the way another program does. */
function openLink (link) {
  if (process.platform === 'win32') return run('powershell', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:ORIVON_LINK'], { ORIVON_LINK: link })
  return run('open', [link])
}

async function addressOf (port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => [])
  const shell = shellTarget(targets)
  if (shell === undefined) return undefined
  return await evaluate(shell.webSocketDebuggerUrl, "document.querySelector('#address')?.value").catch(() => undefined)
}

async function reachesRunningApp (executable) {
  const env = { ...process.env, ORIVON_INTRO: 'off', ORIVON_TELEMETRY: 'off', ORIVON_UPDATE_CHECK: 'off', ORIVON_SECURE_DNS: 'off', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_WINDOW_NO_FOCUS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  child.on('error', (error) => { log += `\n${error.message}` })
  try {
    await waitForShell(child, () => log, Date.now() + STARTUP_TIMEOUT_MS)
    const port = devToolsPort(log)
    record('the app started on the default profile', true)

    const refused = openLink(REFUSED_LINK)
    await sleep(REFUSAL_SETTLE_MS)
    const afterRefused = await addressOf(port)
    record('a link naming an https address opens nothing', refused.status === 0 && !String(afterRefused).includes('example.com'), String(afterRefused))

    const opened = openLink(LINK)
    let address
    for (const deadline = Date.now() + REACH_TIMEOUT_MS; Date.now() < deadline;) {
      address = await addressOf(port)
      if (address === OPENED_ADDRESS) break
      await sleep(1000)
    }
    record('an orivon: link handed to the system reaches the running app', opened.status === 0 && address === OPENED_ADDRESS, `address ${String(address)}, expected ${OPENED_ADDRESS}`)
  } catch (error) {
    record('the app started on the default profile', false, `${error.message}\n${log.split('\n').slice(-40).join('\n')}`)
  } finally {
    await stop(child)
  }
}

/** Windows only: with nothing running, the system starts the app and the link is on its command line. */
async function startsFromLink () {
  if (process.platform !== 'win32') return
  spawnSync('taskkill', ['/IM', 'Orivon.exe', '/T', '/F'], { stdio: 'ignore' })
  await sleep(3000)
  const started = openLink(LINK)
  const find = "Get-CimInstance Win32_Process -Filter \"Name = 'Orivon.exe'\" | Where-Object { $_.CommandLine -match 'orivon:open' } | ForEach-Object { $_.CommandLine }"
  let found = ''
  for (const deadline = Date.now() + REACH_TIMEOUT_MS; Date.now() < deadline && found === '';) {
    found = run('powershell', ['-NoProfile', '-Command', find]).stdout.trim()
    if (found === '') await sleep(1000)
  }
  record('an orivon: link starts the app that is not running, with the link after --', started.status === 0 && /--\s+"?orivon:open/.test(found), found)
  spawnSync('taskkill', ['/IM', 'Orivon.exe', '/T', '/F'], { stdio: 'ignore' })
}

if (isInvokedDirectly(import.meta.url)) {
  const [executable, bundle] = process.argv.slice(2)
  if (executable === undefined || (process.platform === 'darwin' && bundle === undefined)) {
    console.error('usage: node scripts/smoke-orivon-link.mjs <executable> [<app bundle>, required on macOS]')
    process.exit(1)
  }
  if (process.platform === 'win32') windowsRegistration()
  else if (process.platform === 'darwin') macRegistration(bundle)
  else record('this system has no registration to read', false)
  await reachesRunningApp(executable)
  await startsFromLink()
  process.exit(results.every((result) => result.ok) ? 0 : 1)
}
