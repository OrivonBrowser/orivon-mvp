// The egress guard's own tests. It exists so that no code path to the network is added without a row in
// docs/architecture/egress.md saying how it takes the tunnel, so each way of reaching out gets a test: an import in each
// spelling, Electron's `net`, a session's `fetch`, a proxy setting, the global `fetch`, and each way of hiding one
// (a comment, a type-only import, a parameter that merely shares the name).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEgress, findEgress, tableFiles, TABLE_FILE } from '../check-egress.mjs'

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-egress-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

const row = (file: string): string => `| \`${file}\` | somewhere | a reason | never leaves this computer |`
const table = (...files: string[]): string => `# Egress\n\n| File | Reaches | For | Tunnel |\n|---|---|---|---|\n${files.map(row).join('\n')}\n`

const reasons = (line: string, file = 'src/main/a.ts'): string[] => findEgress(line, file)

describe('what findEgress sees', () => {
  it.each([
    ['a named import', 'import { connect } from \'node:net\'\n'],
    ['a bare module name', 'import { connect } from \'net\'\n'],
    ['a default import', 'import https from \'node:https\'\n'],
    ['a namespace import', 'import * as dns from \'node:dns/promises\'\n'],
    ['a side-effect import', 'import \'node:tls\'\n'],
    ['a multi-line import', 'import {\n  createServer,\n  request\n} from \'node:http\'\n'],
    ['an import that mixes types and values', 'import { type Socket, connect } from \'node:net\'\n'],
    ['a re-export', 'export { connect } from \'node:net\'\n'],
    ['require', 'const net = require(\'node:net\')\n'],
    ['a dynamic import', 'const dgram = await import(\'node:dgram\')\n'],
    ['getBuiltinModule', 'const http2 = process.getBuiltinModule(\'node:http2\')\n'],
    ['the broker\'s socket adapters', 'import { dialTcp } from \'../../broker/adapters/node-adapters.js\'\n'],
    ['the socks package', 'import { SocksClient } from \'socks\'\n'],
    ['Electron net.request', 'const r = net.request({ url })\n'],
    ['Electron net.fetch', 'const r = await net.fetch(url)\n'],
    ['a session fetch', 'await appSession.fetch(request)\n'],
    ['a fetch through a web contents', 'await wc.session.fetch(url, init)\n'],
    ['app.setProxy', 'await app.setProxy({ mode: \'direct\' })\n'],
    ['session.setProxy', 'await session.setProxy({ mode: \'system\' })\n'],
    ['globalThis.fetch', 'const original = globalThis.fetch\n'],
    ['a fallback to the global fetch', 'const get = deps.fetch ?? fetch\n'],
    ['a fallback to the global fetch declared elsewhere', 'function g (fetch: Fetch) {}\nconst get = deps.fetch || fetch\n'],
    ['Electron net under another name', 'import { net as enet } from \'electron\'\n'],
    ['a request function taken out of net', 'const { request } = net\n'],
    ['a WebSocket', 'const socket = new WebSocket(url)\n'],
    ['an EventSource', 'const events = new EventSource(url)\n']
  ])('sees %s', (_name, source) => {
    expect(reasons(source).length).toBeGreaterThan(0)
  })

  it('sees the global fetch called bare in Node-side code', () => {
    expect(reasons('const r = await fetch(url)\n', 'src/protocols/a.ts')).toHaveLength(1)
    expect(reasons('const r = await fetch(url)\n', 'src/loader/a.ts')).toHaveLength(1)
    expect(reasons('const r = await fetch(url)\n', 'src/broker/a.ts')).toHaveLength(1)
    expect(reasons('const r = await fetch(url)\n', 'src/telemetry/a.ts')).toHaveLength(1)
  })

  it('names what it saw', () => {
    expect(reasons('import { connect } from \'node:net\'\nnet.fetch(u)\n')).toEqual(['imports node:net', 'calls net.fetch'])
  })
})

describe('what findEgress leaves alone', () => {
  it.each([
    ['a type-only import', 'import type { Socket } from \'node:net\'\n'],
    ['an import of types only', 'import { type Socket, type Server } from \'node:net\'\n'],
    ['a multi-line type-only import', 'import type {\n  Socket,\n  Server\n} from \'node:net\'\n'],
    ['a type-only import of the adapters', 'import type { Dial } from \'../adapters/tls-adapter.js\'\n'],
    ['a module that is not a network one', 'import { join } from \'node:path\'\nimport { spawn } from \'node:child_process\'\n'],
    ['a similar package name', 'import x from \'netmask\'\nimport y from \'http-proxy-agent\'\n'],
    ['a comment', '// import { connect } from \'node:net\' and net.fetch(url), setProxy( and fetch(\n/* globalThis.fetch */\n'],
    ['an injected fetch on deps', 'await deps.fetch(url, init)\n'],
    ['an injected fetch on options', 'await options.fetch(url)\n'],
    ['a fetch the file receives as a parameter', 'export async function get (url: string, fetch: WebFetch) { return await fetch(url) }\n'],
    ['a fetch the file receives untyped', 'export const get = (fetch) => fetch(url)\n'],
    ['a fetch destructured from an option object', 'const { fetch } = options\nawait fetch(url)\n'],
    ['a local named fetch', 'const fetch = makeFetch()\nawait fetch(url)\n'],
    ['an unrelated property that reads net', 'const x = { net: orivon.net as SocketNet }\n'],
    ['a method of the class itself', 'void this.fetch()\n'],
    ['a method called fetch on something else', 'await cache.fetchOne(url)\nconst prefetch = 1\nprefetch(2)\n']
  ])('ignores %s', (_name, source) => {
    expect(reasons(source, 'src/protocols/a.ts')).toEqual([])
  })

  it('does not take an object key for a declaration of fetch', () => {
    expect(reasons('const config = { fetch: deps.dohFetch ?? fetch }\nawait fetch(url)\n', 'src/protocols/a.ts')).toEqual(['falls back to the global fetch', 'calls the global fetch'])
  })

  it('leaves a WebSocket in a page-side file alone', () => {
    expect(reasons('new WebSocket(url)\n', 'src/renderer/a.ts')).toEqual([])
  })

  it('leaves a fetch in a page-side file alone, and globalThis.fetch in it is still seen', () => {
    expect(reasons('await fetch(url)\n', 'src/renderer/a.ts')).toEqual([])
    expect(reasons('await fetch(url)\n', 'src/preload/a.ts')).toEqual([])
    expect(reasons('await fetch(url)\n', 'src/shim/worker/a.ts')).toEqual([])
    expect(reasons('const f = target.fetch.bind(target)\n', 'src/preload/a.ts')).toEqual([])
    expect(reasons('const f = globalThis.fetch\n', 'src/preload/a.ts')).toEqual(['uses globalThis.fetch'])
  })
})

describe('tableFiles', () => {
  it('reads the first backticked path of each row, in any table on the page', () => {
    const page = `${table('src/a.ts', 'src/b/c.ts')}\n\nProse naming \`src/not-a-row.ts\`.\n\n| \`src/d.ts\` | x | y | z |\n`
    expect([...tableFiles(page)].sort()).toEqual(['src/a.ts', 'src/b/c.ts', 'src/d.ts'])
  })
})

describe('checkEgress', () => {
  const code = 'import { connect } from \'node:net\'\n'

  it('fails a file that is not in the table', () => {
    const result = checkEgress(repo({ 'src/main/a.ts': code, [TABLE_FILE]: table() }))
    expect(result.ok).toBe(false)
    expect(result.unlisted).toEqual([{ file: 'src/main/a.ts', reasons: ['imports node:net'] }])
  })

  it('fails a row for a file that is gone', () => {
    const result = checkEgress(repo({ 'src/main/a.ts': 'export const a = 1\n', [TABLE_FILE]: table('src/main/gone.ts') }))
    expect(result.ok).toBe(false)
    expect(result.stale).toEqual(['src/main/gone.ts'])
  })

  it('fails a row for a file that exists but no longer reaches the network', () => {
    const result = checkEgress(repo({ 'src/main/a.ts': code, 'src/main/b.ts': 'export const b = 1\n', [TABLE_FILE]: table('src/main/a.ts', 'src/main/b.ts') }))
    expect(result.ok).toBe(false)
    expect(result.stale).toEqual(['src/main/b.ts'])
  })

  it('passes a file in the table', () => {
    const result = checkEgress(repo({ 'src/main/a.ts': code, [TABLE_FILE]: table('src/main/a.ts') }))
    expect(result).toEqual({ ok: true, unlisted: [], stale: [], unreadable: [] })
  })

  it('does not ask for tests, declaration files or anything outside src', () => {
    const result = checkEgress(repo({
      'src/main/tests/a.test.ts': code, 'src/main/b.test.ts': code, 'src/main/c.d.ts': code,
      'src/main/tests/d.test-helpers.ts': code, 'scripts/e.mjs': code, 'test/f.ts': code, [TABLE_FILE]: table()
    }))
    expect(result.ok).toBe(true)
  })

  it('fails when the table is missing, rather than reading it as empty', () => {
    const result = checkEgress(repo({ 'src/main/a.ts': 'export const a = 1\n' }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/egress\.md/)
  })

  it('fails when the directory is not a git tree, rather than reading it as clean', () => {
    const result = checkEgress(mkdtempSync(join(tmpdir(), 'orivon-not-git-')))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not list/)
  })
})
