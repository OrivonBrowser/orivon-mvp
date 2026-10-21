// An app tab's `process` and `os` answer as Node does (d-0594), so a library that
// branches on them takes the path it takes under Node and Electron: a version in
// `process.version` and `process.versions.node`, no `process.browser`, platform
// 'linux' and arch 'x64' on every host, and `os` agreeing with `process`.
//
// The libraries are tiny fixtures written here, each branching the way a real one
// does (a stream API enabled by `process.versions.node`, a table keyed on
// `process.platform` that throws for an unknown one, `process.browser` read for the
// browser branch, the '[object process]' tag), bundled into the page with the
// shim's own `os`. The app origin is registered through the developer-only grant
// hook before navigating, as e2e-page-buffer.test.ts does and for the same reason.
//
// Hermetic: one throwaway server on a loopback port the OS picks.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const APP_TITLE = 'node shaped process fixture'

const FIRST = `window.__process = (() => {
  const p = window.process
  return p === undefined ? null : {
    version: p.version, node: p.versions && p.versions.node, electron: p.versions && p.versions.electron,
    hasBrowser: 'browser' in p, platform: p.platform, arch: p.arch, title: p.title, release: p.release && p.release.name,
    tag: Object.prototype.toString.call(p), type: p.type
  }
})()`

// Libraries as they branch in the wild, bundled with the shim's `os`.
const LIBRARIES = `import os from './src/shim/polyfills/os.js'

// iconv-lite: a stream API only where process.versions.node is set.
const streamsEnabled = typeof process !== 'undefined' && !!process.versions && !!process.versions.node
const nodeMajor = streamsEnabled ? Number(process.versions.node.split('.')[0]) : null

// application-config-path: a table keyed on the platform, throwing for one it does not know.
function configDir () {
  const home = process.env.HOME
  switch (process.platform) {
    case 'linux': return (process.env.XDG_CONFIG_HOME || home + '/.config')
    case 'darwin': return home + '/Library/Application Support'
    case 'win32': return process.env.APPDATA
    default: throw new Error('Platform not supported: ' + process.platform)
  }
}
let config
try { config = configDir() } catch (error) { config = 'threw: ' + error.message }

// debug, bittorrent-tracker: the browser branch is process.browser.
const takesBrowserBranch = process.browser === true

// detect-node
const detectsNode = Object.prototype.toString.call(typeof process !== 'undefined' ? process : 0) === '[object process]'

window.__libraries = {
  streamsEnabled, nodeMajorIsNumber: typeof nodeMajor === 'number' && nodeMajor > 0, config, takesBrowserBranch, detectsNode,
  osPlatform: os.platform(), osType: os.type(), osArch: os.arch(), osMatchesProcess: os.platform() === process.platform && os.arch() === process.arch
}`

const script = (path: string): string => `<script src="${path}"></script>`
const APP_PAGE = `<!doctype html><html><head>${script('/first.js')}${script('/libraries.js')}<title>${APP_TITLE}</title></head><body>${APP_TITLE}</body></html>`

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.node-shaped-process-e2e',
    name: 'Node-shaped process e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: ['libraries.js'],
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

async function listen (handler: Parameters<typeof createServer>[1]): Promise<{ server: Server, origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }
}

async function register (app: ElectronApplication, origin: string): Promise<boolean> {
  return await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin, manifest: manifest(), capability: 'tcp.connect', patterns: [] } satisfies DevGrantRequest)
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000

it('[app:process-is-node-shaped] gives an app tab a Node process: a version, no browser flag, linux and x64, and libraries take their Node path', async () => {
  await runPhase('node-shaped process', async (check) => {
    const libraries = (await esbuild.build({
      stdin: { contents: LIBRARIES, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'node-shaped-libraries.ts' },
      bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent'
    })).outputFiles[0]?.text ?? ''
    const js = { 'content-type': 'text/javascript; charset=utf-8' }
    const appServer = await listen((req, res) => {
      if (req.url === '/first.js') { res.writeHead(200, js); res.end(FIRST); return }
      if (req.url === '/libraries.js') { res.writeHead(200, js); res.end(libraries); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(APP_PAGE)
    })
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const registered = await register(app, appServer.origin)
      check('the developer-only grant hook is installed (npm run test:e2e builds with it)', registered)
      if (!registered) return

      const view = await navigateToFixture(app, `${appServer.origin}/`, APP_TITLE)
      const seen = await evaluateRetrying(view, () => (window as unknown as { __process: Record<string, unknown> | null }).__process)
      check('process.version is a Node version, v-prefixed, and process.versions.node is the same without the v',
        seen !== null && typeof seen['version'] === 'string' && /^v\d+\.\d+\.\d+$/.test(seen['version']) && seen['version'] === `v${String(seen['node'])}`, JSON.stringify(seen))
      check('process has no browser flag, as in Node', seen !== null && seen['hasBrowser'] === false, JSON.stringify(seen))
      check('the platform is linux and the arch x64 on every host', seen !== null && seen['platform'] === 'linux' && seen['arch'] === 'x64', JSON.stringify(seen))
      check('the title and release name are node, and the tag is [object process]',
        seen !== null && seen['title'] === 'node' && seen['release'] === 'node' && seen['tag'] === '[object process]', JSON.stringify(seen))
      check('Electron\'s identity is not claimed: no versions.electron and no process.type',
        seen !== null && seen['electron'] === undefined && seen['type'] === undefined, JSON.stringify(seen))

      const found = await evaluateRetrying(view, () => (window as unknown as { __libraries: Record<string, unknown> }).__libraries)
      check('a library enabling streams on process.versions.node enables them, with a numeric major', found['streamsEnabled'] === true && found['nodeMajorIsNumber'] === true, JSON.stringify(found))
      check('a table keyed on process.platform finds linux and answers an XDG directory under the app\'s home',
        found['config'] === '/orivon/app/.config', JSON.stringify(found))
      check('a library reading process.browser takes its Node branch, and a detector finds [object process]',
        found['takesBrowserBranch'] === false && found['detectsNode'] === true, JSON.stringify(found))
      check('os.platform(), os.type() and os.arch() agree with process',
        found['osPlatform'] === 'linux' && found['osType'] === 'Linux' && found['osArch'] === 'x64' && found['osMatchesProcess'] === true, JSON.stringify(found))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await new Promise<void>((resolve) => { appServer.server.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
