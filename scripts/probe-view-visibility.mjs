/**
 * Whether every view that is on screen is shown, read the way the browser process sees it and with no
 * Playwright anywhere. Playwright attaches a debugger to every page it drives and a page with one reports
 * itself visible, so a view that was taken out of its window and put back stays hidden (its
 * `document.visibilityState` is `hidden` and `requestAnimationFrame` never fires) without any spec seeing it.
 *
 * This script launches the built app (`npm run build` first) on a throwaway profile, connects to its MAIN
 * process only (`--inspect`: a debugger on the main process does not touch a page), drives the tab strip through
 * the chrome page's own `orivonShell` calls, and after each step reads, for every view in the window, whether it
 * is visible, what the page's `visibilityState` says and whether a `requestAnimationFrame` round trip arrives.
 * A view that is in the window and in front but hidden fails the step. Exit status 1 on any failure.
 *
 * Usage: node scripts/run-headless.mjs node scripts/probe-view-visibility.mjs [--only=<scenario>] [--json]
 * Scenarios: switch, split, navigate, sleep, panel, windows, popup. PROBE_ARGS adds Electron switches (for instance
 * --ozone-platform=wayland under a private compositor). PROBE_AFTER_STEP is a shell command run after each step
 * with the step's name in PROBE_STEP: a screenshot of the display, to read the compositor's pixels as well.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = createRequire(import.meta.url)('electron')
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const asJson = process.argv.includes('--json')

const sleep = async (ms) => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** Pages that tell themselves apart by title, so a tab is found by what it shows. */
function pageServer () {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url}</title><body style="margin:0;height:100vh;background:#1e8c5a"><p>${request.url}</p></body>`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }) })
  })
}

/** Puts the fixture extension with a toolbar popup into `profile` the way an install would leave it; returns its id. */
function seedPopupExtension (profile) {
  const source = join(repo, 'test/apps/extensions/action-popup')
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const id = [...createHash('sha256').update(key, 'base64').digest().subarray(0, 16).toString('hex')].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('')
  const slot = join(profile, 'extensions', 'action-popup')
  const target = join(slot, '1.0.0')
  cpSync(source, target, { recursive: true })
  const manifest = { ...JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')), key }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(slot, 'key.pub'), key)
  const now = Date.now()
  const entry = { id, name: manifest.name, version: manifest.version, enabled: true, installedAt: now, updatedAt: now, source: { kind: 'unpacked', from: source }, updater: { kind: 'none', reason: 'probe fixture' }, path: target, stripped: { permissions: [], optionalPermissions: [] } }
  mkdirSync(join(profile, 'extensions'), { recursive: true })
  writeFileSync(join(profile, 'extensions', 'registry.json'), JSON.stringify({ extensions: [entry] }))
  return id
}

/** The app on a fresh profile with a debugger on its main process; resolves with that process's inspector address. */
async function launch (seed) {
  const profile = mkdtempSync(join(tmpdir(), 'orivon-test-probe-'))
  const seeded = seed?.(profile)
  const env = { ...process.env, ORIVON_WINDOW_NO_FOCUS: '1', ORIVON_INTRO: 'off', ORIVON_TELEMETRY: 'off', ORIVON_ETH_LIGHT_CLIENT: 'off', PULSE_SERVER: 'unix:/nonexistent' }
  delete env.ELECTRON_RUN_AS_NODE
  const args = ['.', `--user-data-dir=${profile}`, '--inspect=0', '--alsa-output-device=null', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', ...(process.env.PROBE_ARGS ?? '').split(' ').filter(Boolean)]
  const child = spawn(electronPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`no inspector address after 30 s:\n${log}`)) }, 30_000)
    const take = (chunk) => {
      log += chunk.toString()
      const found = /ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/.exec(log)
      if (found !== null) { clearTimeout(timer); resolve(found[0]) }
    }
    child.stderr.on('data', take)
    child.stdout.on('data', take)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the app exited with ${code}:\n${log}`)) })
  })
  const close = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    for (let waited = 0; child.exitCode === null && waited < 8000; waited += 100) await sleep(100)
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return { wsUrl, close, output: () => log, seeded }
}

/** A Runtime.evaluate client for the main process: no domain is enabled, so no page is touched. */
async function connect (wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let next = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const wait = pending.get(message.id)
    if (wait === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) wait.reject(new Error(message.error.message))
    else if (message.result.exceptionDetails !== undefined) wait.reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
    else wait.resolve(message.result.result.value)
  }
  return async (expression) => await new Promise((resolve, reject) => {
    next += 1
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

/** Installed once in the main process: reads the window's views and calls into the chrome page. */
const HELPERS = `(() => {
  const { BaseWindow, Menu, webContents } = process.mainModule.require('electron')
  const first = BaseWindow.getAllWindows()[0]
  const children = () => first.contentView.children
  const chromeContents = () => children().find((v) => v.webContents && v.webContents.getURL().includes('/renderer/index.html')).webContents
  const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))])
  globalThis.__vp = {
    chrome: (js) => chromeContents().executeJavaScript(js),
    urls: () => webContents.getAllWebContents().map((c) => c.getURL()),
    read: async () => {
      const out = []
      for (const view of BaseWindow.getAllWindows().flatMap((window) => window.contentView.children)) {
        const wc = view.webContents
        if (!wc || wc.isDestroyed()) { out.push({ url: '(no page)', viewVisible: view.getVisible() }); continue }
        const state = await withTimeout(wc.executeJavaScript('document.visibilityState'), 2000, 'no-answer')
        const raf = await withTimeout(wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => r("frame")))'), 1500, 'no-frame')
        out.push({ url: wc.getURL(), viewVisible: view.getVisible(), state, raf, bounds: view.getBounds() })
      }
      return out
    },
    patchMenu: () => { Menu.prototype.popup = function () { globalThis.__vp.popped = this } },
    menu: () => globalThis.__vp.popped === undefined ? null : globalThis.__vp.popped.items.map((i) => ({ label: i.label, sub: i.submenu ? i.submenu.items.map((s) => s.label) : null })),
    clickMenu: (path) => {
      let items = globalThis.__vp.popped.items
      for (const label of path.slice(0, -1)) items = items.find((i) => i.label === label).submenu.items
      items.find((i) => i.label === path.at(-1)).click()
    }
  }
  return 'ok'
})()`

const wants = (name) => only === undefined || only === name

const failures = []
const report = []

async function main () {
  const { origin: a } = await pageServer()
  const { origin: b } = await pageServer()
  const app = await launch(wants('popup') ? seedPopupExtension : undefined)
  try {
    const run = await connect(app.wsUrl)
    for (let waited = 0; ; waited += 250) {
      try { await run(HELPERS); await run('__vp.chrome("1")'); break } catch (error) {
        if (waited > 120_000) throw error
        await sleep(250)
      }
    }
    const chrome = async (js) => await run(`__vp.chrome(${JSON.stringify(js)})`)
    const shell = async (call) => { await chrome(`window.orivonShell.${call}`) }
    const tabs = async () => await chrome(`[...document.querySelectorAll('.tab')].map((e) => ({ id: e.dataset.id, title: e.querySelector('.title')?.textContent ?? '', active: e.classList.contains('active'), joined: e.classList.contains('joined') }))`)
    const idOf = async (title) => (await tabs()).find((tab) => tab.title === title)?.id
    const waitFor = async (what, check, ms = 15_000) => {
      for (let waited = 0; waited < ms; waited += 150) { if (await check()) return; await sleep(150) }
      throw new Error(`timed out waiting for ${what}`)
    }
    const openTab = async (url, title) => {
      await shell(`newTab(${JSON.stringify(url)})`)
      await waitFor(`the tab "${title}"`, async () => (await tabs()).some((tab) => tab.title === title))
    }

    /** After a step: every page in `shown` (a part of its address) must be a visible, painting view of the window. */
    const expectShown = async (scenario, step, shown) => {
      await sleep(900)
      const views = await run('__vp.read()')
      // The compositor's own pixels, for a run that wants them: PROBE_AFTER_STEP is a shell command that gets the step's name in PROBE_STEP.
      if (process.env.PROBE_AFTER_STEP) spawnSync(process.env.PROBE_AFTER_STEP, { shell: true, env: { ...process.env, PROBE_STEP: `${scenario}-${step}`.replace(/[^a-z0-9]+/gi, '_') }, stdio: 'ignore' })
      const verdicts = shown.map((part) => {
        const view = views.find((candidate) => candidate.url.includes(part))
        if (view === undefined) return { part, ok: false, why: 'not in the window' }
        const ok = view.viewVisible && view.state === 'visible' && view.raf === 'frame'
        return { part, ok, why: ok ? '' : `visible=${view.viewVisible} state=${view.state} raf=${view.raf}` }
      })
      for (const verdict of verdicts) if (!verdict.ok) failures.push(`${scenario} / ${step}: ${verdict.part} ${verdict.why}`)
      report.push({ scenario, step, verdicts, views: views.map((view) => `${view.url.slice(0, 60)} ${view.viewVisible ? 'visible' : 'setVisible(false)'} ${view.state} ${view.raf}`) })
    }
    const partOf = (title) => title.startsWith('Page /') ? title.slice('Page '.length) : '/newtab/'
    await openTab(`${a}/a`, 'Page /a')
    await openTab(`${a}/b`, 'Page /b')
    await openTab(`${a}/c`, 'Page /c')
    await expectShown('setup', 'three tabs opened, /c in front', ['/c'])

    if (wants('switch')) {
      for (const [title, part] of [['Page /a', '/a'], ['Page /b', '/b'], ['Page /c', '/c'], ['Page /a', '/a'], ['Page /c', '/c'], ['Page /b', '/b']]) {
        await shell(`activateTab(${JSON.stringify(await idOf(title))})`)
        await expectShown('switch', `activate ${title}`, [part])
      }
    }

    if (wants('split')) {
      await shell(`activateTab(${JSON.stringify(await idOf('Page /a'))})`)
      await run('__vp.patchMenu()')
      await shell("runCommand('split.toggle')")
      await waitFor('a split', async () => (await tabs()).filter((tab) => tab.joined).length === 2)
      const pair = (await tabs()).filter((tab) => tab.joined).map((tab) => tab.title)
      const parts = pair.map((title) => partOf(title))
      await expectShown('split', `split.toggle joins ${pair.join(' + ')}`, parts)
      await shell("runCommand('split.swap')")
      await expectShown('split', 'swap the panes', parts)
      await shell("runCommand('split.focusOther')")
      await expectShown('split', 'go to the other pane', parts)
      await shell("runCommand('split.rotate')")
      await expectShown('split', 'stack the panes', parts)
      await shell("runCommand('split.rotate')")
      await shell("runCommand('split.toggle')")
      await waitFor('the split to end', async () => (await tabs()).every((tab) => !tab.joined))
      const front = (await tabs()).find((tab) => tab.active)
      await expectShown('split', 'split ended', [partOf(front.title)])

      // The menu of a tab that is behind the one in front: the tab it names is brought in beside the front one.
      const behind = (await tabs()).find((tab) => !tab.active && tab.title.startsWith('Page /') && tab.title !== 'Page /c')
      const menuTab = behind ?? (await tabs()).find((tab) => !tab.active)
      await chrome(`document.querySelector('.tab[data-id="${menuTab.id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 20 }))`)
      await waitFor('the tab menu', async () => (await run('__vp.menu()')) !== null)
      const partner = (await run('__vp.menu()')).find((item) => item.label === 'Split with').sub.find((label) => label.startsWith('Page /'))
      await run(`__vp.clickMenu(['Split with', ${JSON.stringify(partner)}])`)
      await waitFor('the menu split', async () => (await tabs()).filter((tab) => tab.joined).length === 2)
      const menuPair = (await tabs()).filter((tab) => tab.joined).map((tab) => partOf(tab.title))
      await expectShown('split', `"Split with" ${partner}`, menuPair)

      if (wants('navigate') || only === undefined) {
        const [, second] = (await tabs()).filter((tab) => tab.joined)
        for (const [label, url, part] of [['same-origin', `${a}/n1`, '/n1'], ['cross-origin', `${b}/n2`, '/n2'], ['again', `${b}/n3`, '/n3']]) {
          await shell(`navigate(${JSON.stringify(second.id)}, ${JSON.stringify(url)})`)
          await waitFor(`${label} load`, async () => (await run('__vp.urls()')).some((u) => u.includes(part)))
          await expectShown('navigate', `${label} navigation in a split pane to ${part}`, [part, menuPair.find((p) => !second.title.includes(p))])
        }
      }
      await shell("runCommand('split.toggle')")
      await waitFor('the split to end', async () => (await tabs()).every((tab) => !tab.joined))
    }

    if (wants('sleep')) {
      const target = (await tabs()).find((tab) => !tab.active && tab.title.startsWith('Page /'))
      await shell(`activateTab(${JSON.stringify(target.id)})`)
      await shell("runCommand('tab.sleep')")
      await waitFor('the tab to sleep', async () => (await tabs()).find((tab) => tab.id === target.id) !== undefined && !(await tabs()).find((tab) => tab.id === target.id).active)
      await sleep(500)
      await shell(`activateTab(${JSON.stringify(target.id)})`)
      await expectShown('sleep', 'the sleeping tab woken', [partOf(target.title)])
      for (const tab of (await tabs()).filter((t) => t.id !== target.id).slice(0, 2)) {
        await shell(`activateTab(${JSON.stringify(tab.id)})`)
        await expectShown('sleep', `then ${tab.title}`, [partOf(tab.title)])
      }
    }

    if (wants('panel')) {
      const front = partOf((await tabs()).find((tab) => tab.active).title)
      for (let round = 1; round <= 3; round += 1) {
        await shell("runCommand('sidePanel.toggle')")
        await sleep(700)
        const open = await run('__vp.read()')
        const panel = open.find((view) => /side-panel|overlay/.test(view.url) && view.bounds.width < 600 && view.bounds.height > 300)
        if (panel !== undefined) await expectShown('panel', `open ${round}`, [panel.url.split('?')[0].slice(-40)])
        await expectShown('panel', `open ${round}, the page in front`, [front])
        await shell("runCommand('sidePanel.toggle')")
        await expectShown('panel', `closed ${round}, the page in front`, [front])
      }
    }

    if (wants('popup')) {
      // An extension's popup is a view in the window: opened twice, it is each time shown, painting, and inside the window.
      const extensionId = app.seeded
      const popupPart = `chrome-extension://${extensionId}/popup.html`
      const content = JSON.parse(await run("JSON.stringify(process.mainModule.require('electron').BaseWindow.getAllWindows()[0].getContentBounds())"))
      const toggle = async () => { await chrome(`document.querySelector('browser-action-list').shadowRoot.getElementById(${JSON.stringify(extensionId)}).click()`) }
      for (const round of [1, 2]) {
        await toggle()
        await waitFor(`the popup, round ${round}`, async () => (await run('__vp.urls()')).some((url) => url.startsWith(popupPart)))
        await expectShown('popup', `open ${round}`, [popupPart])
        const view = (await run('__vp.read()')).find((candidate) => candidate.url.startsWith(popupPart))
        const inside = view !== undefined && view.bounds.x >= 0 && view.bounds.y >= 0 && view.bounds.x + view.bounds.width <= content.width && view.bounds.y + view.bounds.height <= content.height
        if (!inside) failures.push(`popup / open ${round}: its bounds ${JSON.stringify(view?.bounds)} are not inside the window ${JSON.stringify(content)}`)
        await toggle()
        await waitFor(`the popup to close, round ${round}`, async () => !(await run('__vp.urls()')).some((url) => url.startsWith(popupPart)))
        await expectShown('popup', `closed ${round}, the page in front`, [partOf((await tabs()).find((tab) => tab.active).title)])
      }
    }

    if (wants('windows')) {
      const moved = (await tabs()).find((tab) => tab.active && tab.title.startsWith('Page /'))
      await shell("runCommand('tab.moveToNewWindow')")
      await waitFor('a second window', async () => (await run("process.mainModule.require('electron').BaseWindow.getAllWindows().length")) === 2)
      await expectShown('windows', `${moved.title} moved to a new window`, [partOf(moved.title)])
    }
  } finally {
    await app.close()
  }
}

try {
  await main()
} catch (error) {
  failures.push(`probe error: ${error.stack ?? error}`)
}
if (asJson) console.log(JSON.stringify({ report, failures }, null, 2))
else {
  for (const entry of report) {
    console.log(`${entry.verdicts.every((v) => v.ok) ? 'ok  ' : 'FAIL'} ${entry.scenario} / ${entry.step}`)
    for (const view of entry.views) console.log(`       ${view}`)
  }
  console.log(failures.length === 0 ? 'every view that is on screen is shown' : `${failures.length} view(s) on screen are hidden:\n  ${failures.join('\n  ')}`)
}
process.exit(failures.length === 0 ? 0 : 1)
