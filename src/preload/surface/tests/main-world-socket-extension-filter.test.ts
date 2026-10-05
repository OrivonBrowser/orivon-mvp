// main-world-socket.ts's own extension-code refusal (that file's README.md
// Design notes): the decision rule tested directly over synthetic frames,
// a drift check against the real installOrivon source, and an integration
// pass through installOrivon itself using real V8 stack frames built with
// `node:vm` (a page-like `https:` frame, a `chrome-extension:` one, an
// eval from each, and the tamper paths) -- as close to "code whose frames
// you control" as Vitest under Node gets; see this file's own README
// pointer in main-world-socket.ts's header for why a pure top-level copy
// exists here rather than an export from that file.
import vm from 'node:vm'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult } from './main-world-socket.test-helpers.js'

// ---------------------------------------------------------------------
// A verbatim copy of installOrivon's own hasSource/callerIsRefused -- see
// 'declares no drift from installOrivon's own copy' below, which extracts
// the real ones from installOrivon.toString() and asserts textual equality
// against these two. Never call installOrivon's own copies directly: they
// are private to its closure (main-world-socket.ts's own header explains
// why -- executeInMainWorld serialises that function alone).
// ---------------------------------------------------------------------
const someOwn = Array.prototype.some
const indexOfOwn = String.prototype.indexOf
const startsWithOwn = String.prototype.startsWith
const applyOwn = Reflect.apply
function hasSource (text: unknown, needles: readonly string[]): boolean {
  return typeof text === 'string' && applyOwn(someOwn, needles, [(needle: string) => applyOwn(indexOfOwn, text, [needle]) !== -1])
}
interface CallerFrame { fileName?: string, scriptNameOrSourceURL?: string, evalOrigin?: string }
function callerIsRefused (frames: readonly CallerFrame[]): boolean {
  const isExtension = (f: CallerFrame): boolean =>
    hasSource(f.fileName, ['chrome-extension://']) || hasSource(f.scriptNameOrSourceURL, ['chrome-extension://']) || hasSource(f.evalOrigin, ['chrome-extension://'])
  // Page attribution uses ONLY a real script's URL (fileName) -- never
  // scriptNameOrSourceURL or an eval origin: a `//# sourceURL=...` comment
  // on string-compiled code rewrites both, at any depth of a nested eval
  // (README.md's Design notes). STARTS-WITH, not contains: unlike extension
  // detection above, a spoofed prefix elsewhere in the string must not count.
  const startsWithAny = (text: unknown, prefixes: readonly string[]): boolean =>
    typeof text === 'string' && applyOwn(someOwn, prefixes, [(prefix: string) => applyOwn(startsWithOwn, text, [prefix])])
  const isPage = (f: CallerFrame): boolean => startsWithAny(f.fileName, ['http://', 'https://', 'blob:http://', 'blob:https://'])
  if (applyOwn(someOwn, frames, [isExtension])) return true
  return !applyOwn(someOwn, frames, [isPage])
}

/** Finds `functionName`'s full declaration text inside `source` by brace balancing -- main-world-socket.test.ts's own `extractFunctionSource`/`findMatching`, duplicated rather than imported (that file's are not exported, and both are a few lines). */
function extractFunctionSource (source: string, functionName: string): string {
  const declIndex = source.indexOf(`function ${functionName}`)
  if (declIndex === -1) throw new Error(`${functionName} not found in installOrivon's own source`)
  const parenOpen = source.indexOf('(', declIndex)
  const parenClose = findMatching(source, parenOpen, '(', ')')
  const braceOpen = source.indexOf('{', parenClose)
  const braceClose = findMatching(source, braceOpen, '{', '}')
  return source.slice(declIndex, braceClose + 1)
}
function findMatching (source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === openChar) depth++
    else if (source[i] === closeChar) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`no matching '${closeChar}' found`)
}

/** Collapses each line's leading whitespace: the two copies sit at different nesting depths (one inside installOrivon's own body, one at this file's top level), so esbuild's own transpiler indents them differently even when every token is identical. */
function ignoringIndentation (text: string): string {
  return text.split('\n').map((line) => line.trimStart()).join('\n')
}

describe('callerIsRefused (pure decision rule)', () => {
  it('declares no drift from installOrivon\'s own copy', () => {
    const source = installOrivon.toString()
    expect(ignoringIndentation(extractFunctionSource(source, 'hasSource'))).toBe(ignoringIndentation(hasSource.toString()))
    expect(ignoringIndentation(extractFunctionSource(source, 'callerIsRefused'))).toBe(ignoringIndentation(callerIsRefused.toString()))
  })

  const PAGE_HTTP = { fileName: 'http://example.test/app.js' }
  const PAGE_HTTPS = { fileName: 'https://example.test/app.js' }
  const PAGE_BLOB_HTTPS = { fileName: 'blob:https://example.test/9f1c-uuid' }
  const PAGE_EVAL = { evalOrigin: 'eval at <anonymous> (https://example.test/app.js:1:1)' }
  const EXTENSION_FILE = { fileName: 'chrome-extension://abcdefghijklmnop/content.js' }
  const EXTENSION_SCRIPT_URL = { scriptNameOrSourceURL: 'chrome-extension://abcdefghijklmnop/content.js' }
  const EXTENSION_EVAL = { evalOrigin: 'eval at run (chrome-extension://abcdefghijklmnop/content.js:1:1)' }
  const OPAQUE = { fileName: 'file:///home/user/script.js' }
  const BLOB_OPAQUE = { fileName: 'blob:null/9f1c-uuid' }

  it('allows a page frame (http:)', () => { expect(callerIsRefused([PAGE_HTTP])).toBe(false) })
  it('allows a page frame (https:)', () => { expect(callerIsRefused([PAGE_HTTPS])).toBe(false) })
  it('allows a page frame (blob: with an https: inner origin)', () => { expect(callerIsRefused([PAGE_BLOB_HTTPS])).toBe(false) })
  it('refuses a page eval origin with no real page frame: eval-origin text can be forged', () => { expect(callerIsRefused([PAGE_EVAL])).toBe(true) })
  it('allows a page eval called from a real page frame', () => { expect(callerIsRefused([PAGE_EVAL, PAGE_HTTPS])).toBe(false) })
  it('refuses an extension frame named by fileName', () => { expect(callerIsRefused([EXTENSION_FILE])).toBe(true) })
  it('refuses an extension frame named by scriptNameOrSourceURL', () => { expect(callerIsRefused([EXTENSION_SCRIPT_URL])).toBe(true) })
  it('refuses an extension eval origin', () => { expect(callerIsRefused([EXTENSION_EVAL])).toBe(true) })
  it('refuses a blob: frame with no http(s) inner origin', () => { expect(callerIsRefused([BLOB_OPAQUE])).toBe(true) })
  it('refuses an opaque (file:) frame with no page or extension source at all', () => { expect(callerIsRefused([OPAQUE])).toBe(true) })
  it('refuses an empty frame list (no attribution at all -- fail closed)', () => { expect(callerIsRefused([])).toBe(true) })
  it('refuses when an extension frame and a page frame are BOTH present -- the extension rule wins', () => {
    expect(callerIsRefused([PAGE_HTTPS, EXTENSION_FILE])).toBe(true)
  })
  it('allows when a page frame is present among several non-extension, non-page frames', () => {
    expect(callerIsRefused([OPAQUE, PAGE_HTTPS, OPAQUE])).toBe(false)
  })

  // `//# sourceURL=https://...` on string-compiled code sets its script
  // name AND replaces its eval origin; it never gives it a fileName.
  const SOURCEURL_SPOOFED_ONLY = { scriptNameOrSourceURL: 'https://example.test/a.js' }
  it('refuses a frame whose ONLY page-looking field is scriptNameOrSourceURL (a sourceURL-comment spoof)', () => {
    expect(callerIsRefused([SOURCEURL_SPOOFED_ONLY])).toBe(true)
  })
  it('still refuses that spoof even alongside an unrelated opaque frame', () => {
    expect(callerIsRefused([OPAQUE, SOURCEURL_SPOOFED_ONLY])).toBe(true)
  })

  // What V8 reports for `new Function(body + '//# sourceURL=x(https://example.test/a.js:1:1)')`,
  // and for a plain `new Function` compiled inside code carrying
  // `//# sourceURL=https://example.test/a.js:1:1`: text identical to a real page eval's.
  const SOURCEURL_EVAL_ORIGIN_SPOOF = { evalOrigin: 'x(https://example.test/a.js:1:1)', scriptNameOrSourceURL: 'x(https://example.test/a.js:1:1)' }
  const SOURCEURL_NESTED_EVAL_ORIGIN_SPOOF = { evalOrigin: 'eval at <anonymous> (https://example.test/a.js:1:1)' }
  it('refuses an eval origin a sourceURL comment forged', () => {
    expect(callerIsRefused([SOURCEURL_EVAL_ORIGIN_SPOOF])).toBe(true)
    expect(callerIsRefused([SOURCEURL_NESTED_EVAL_ORIGIN_SPOOF])).toBe(true)
  })
  const NESTED_PAGE_EVAL = { evalOrigin: 'eval at innerEval (eval at <anonymous> (https://example.test/app.js:4:2))' }
  it('refuses a nested page eval origin alone, and allows it under a real page frame', () => {
    expect(callerIsRefused([NESTED_PAGE_EVAL])).toBe(true)
    expect(callerIsRefused([NESTED_PAGE_EVAL, PAGE_HTTPS])).toBe(false)
  })
  const NESTED_EXTENSION_EVAL_OUTER_PAGE = { evalOrigin: 'eval at <anonymous> (https://example.test/app.js:1:1)', scriptNameOrSourceURL: 'chrome-extension://abcdefghijklmnop/content.js' }
  it('an extension scriptNameOrSourceURL still refuses even when evalOrigin alone would read as page (extension detection is unaffected by the isPage fix)', () => {
    expect(callerIsRefused([NESTED_EXTENSION_EVAL_OUTER_PAGE])).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Integration: real V8 stack frames, built the way the probe measured
// Electron's own attribution (docs/planning/spike-results/extension-
// stack-probe.json) -- a vm.Script compiled with `filename` set to the
// URL being simulated. A function's OWN frame is attributed to where its
// CODE was compiled, never to its caller (confirmed empirically against
// this exact mechanism before writing these tests), so a callback built
// this way keeps its attribution even across an `await`, unlike a plain
// Vitest test-file frame (`file://...`, neither page nor extension code --
// main-world-socket.test-helpers.ts's own `asPage` exists for exactly this
// reason, for every OTHER test in this suite that expects success).
// ---------------------------------------------------------------------

/** Compiles `(fn) => fn()` with `filename`, so calling the RETURNED function later attributes ITS OWN frame there, regardless of caller. */
function frameNamed (filename: string): <T>(fn: () => T) => T {
  return new vm.Script('(fn) => fn()', { filename }).runInThisContext() as <T>(fn: () => T) => T
}

const asPageFrame = frameNamed('https://orivon-test.example/app.js')
const asExtensionFrame = frameNamed('chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js')

describe('installOrivon: real caller attribution', () => {
  it('a page-frame caller succeeds', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }
    await expect(asPageFrame(async () => await orivon.app.manifest())).resolves.toEqual({ orivonApiVersion: 0 })
  })

  it('an extension-frame caller is refused with the denied shape', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }
    await expect(asExtensionFrame(async () => await orivon.app.manifest())).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
  })

  it('a caller with no attributable frame at all is refused (a plain Vitest test-file frame)', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }
    await expect(orivon.app.manifest()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
  })

  it('with attributeCallers false, a caller with no page frame is answered: the child host\'s own install, which never enters a main world', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target, false)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }
    await expect(orivon.app.manifest()).resolves.toEqual({ orivonApiVersion: 0 })
  })

  it('only the child host\'s preload switches attribution off, and the main-world install passes no such argument', () => {
    const read = (file: string): string => readFileSync(resolve(process.cwd(), 'src/preload', file), 'utf8')
    const sources = (readdirSync(resolve(process.cwd(), 'src/preload'), { recursive: true, encoding: 'utf8' }))
      .filter((name) => name.endsWith('.ts') && !name.includes('tests/'))
    const switchedOff = sources.filter((name) => /installOrivon\([\s\S]*?,\s*target,\s*false\)/.test(read(name)))
    expect(switchedOff).toEqual(['child-host.ts'])
    // The serialised main-world call hands installOrivon its bridge and limits and nothing else.
    expect(read('surface/orivon.ts')).toMatch(/func: installOrivon,\s*args: \[bridge, \{[^}]*\}\]/)
  })

  it('fs.readFileSync (the one synchronous method) throws synchronously on refusal, never a rejection', () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult(), undefined, () => ({ id: '', ok: true, result: new Uint8Array() })), LIMITS, target)
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }
    expect(() => { orivon.fs.readFileSync('/a') }).toThrow(expect.objectContaining({ name: 'OrivonError', code: 'denied' }))
  })

  it('fs.readFileSync succeeds for a page-frame caller', () => {
    const target: Record<string, unknown> = {}
    const bytes = new Uint8Array([1, 2, 3])
    installOrivon(fakeBridge(fakeSocketBridgeResult(), undefined, () => ({ id: '', ok: true, result: bytes })), LIMITS, target)
    const orivon = target.orivon as { fs: { readFileSync: (path: string) => Uint8Array } }
    expect(asPageFrame(() => orivon.fs.readFileSync('/a'))).toBe(bytes)
  })

  it('a deferred bound call (setTimeout(orivon.x.bind(...))) is refused: the timer fires with no caller frame at all', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }
    const bound = orivon.app.manifest.bind(orivon.app)
    const result = await new Promise((resolve, reject) => { setTimeout(() => { bound().then(resolve, reject) }, 0) })
      .catch((e: unknown) => e)
    expect(result).toMatchObject({ name: 'OrivonError', code: 'denied' })
  })

  // The whole route an extension's main-world script has: string-compiled
  // code whose sourceURL comment forges a page eval origin, run later by a
  // timer so no extension frame is left on the stack.
  it('string-compiled code with a forged sourceURL, run by a timer, is refused at any eval depth', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const scope = globalThis as { orivonForgeProbe?: unknown }
    scope.orivonForgeProbe = target.orivon
    try {
      const forged = [
        new Function('return orivonForgeProbe.app.manifest() //# sourceURL=x(https://orivon-test.example/app.js:1:1)'),
        new Function('return new Function("return orivonForgeProbe.app.manifest()")() //# sourceURL=https://orivon-test.example/app.js:1:1')
      ] as Array<() => Promise<unknown>>
      for (const fn of forged) {
        const result = await new Promise((resolve, reject) => { setTimeout(() => { fn().then(resolve, reject) }, 0) })
          .catch((e: unknown) => e)
        expect(result).toMatchObject({ name: 'OrivonError', code: 'denied' })
      }
    } finally {
      delete scope.orivonForgeProbe
    }
  })

  it('internal callers reach the unwrapped implementation directly, never refused: net.connect via the internal-net slot', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const internalNet = (target as Record<symbol, { connect: (opts: unknown) => Promise<unknown> } | undefined>)[Symbol.for('orivon.internal-net')]
    expect(internalNet).toBeDefined()
    // No frame at all -- a plain Vitest call -- and still succeeds: this is
    // the UNWRAPPED closure, never routed through the guarded wrapper.
    const socket = await internalNet?.connect({ host: 'x.example', port: 443 })
    expect((socket as { id?: string })?.id).toBe('h1')
  })

  // The routed network path's own shared attribution (../routed/README.md's
  // Design notes) -- exposed on the same private slot, never a second copy
  // of the decision logic.
  it('internal-net also carries callerIsPage, installOrivon\'s own attribution, usable by the routed installers', async () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)
    const internalNet = (target as Record<symbol, { callerIsPage?: (exclude: (...args: never[]) => unknown) => boolean } | undefined>)[Symbol.for('orivon.internal-net')]
    expect(typeof internalNet?.callerIsPage).toBe('function')
    function exclude (): boolean { return internalNet!.callerIsPage!(exclude) }
    expect(asPageFrame(exclude)).toBe(true)
    expect(asExtensionFrame(exclude)).toBe(false)
  })

  describe('tamper paths', () => {
    /**
     * Shared by every tamper script below -- runs entirely inside a
     * throwaway `vm` realm -- its OWN `Error`, never this process's real
     * one. `installOrivon` captures `RealError = Error` at call time (its
     * own top-level const), so rebuilding it fresh inside this context (the
     * P-F6 test's own technique, `new Function` from its source text) makes
     * ITS captured `Error` this realm's, letting a tamper freeze/replace
     * `Error`'s own machinery without corrupting the real one every other
     * test in this file (and this process's own error reporting) depends on.
     */
    const FAKE_BRIDGE_SRC = `
      function fakeBridge () {
        const ok = () => Promise.resolve({ orivonApiVersion: 0 })
        return { appManifest: ok, appGrants: async () => [], appRequestGrant: async () => false,
          fsReadFile: ok, fsWriteFile: ok, fsReadFileSync: () => ({ id: '', ok: true, result: new Uint8Array() }),
          fsMkdir: ok, fsReaddir: async () => [], fsStat: ok, fsRm: ok, fsRename: ok, fsOpen: ok,
          fsUserSelected: async () => [], fsUserSelectedDirectory: async () => null,
          idPublicKey: ok, idSign: ok, secretsAvailable: async () => false, secretsEncrypt: ok, secretsDecrypt: ok, trustWebsiteScore: ok,
          webOpenContext: ok, webSetEmbedScript: ok, netConnect: ok, netConnectSecure: ok, netUdpBind: ok,
          netListen: ok, netLookup: async () => [] }
      }
    `

    function tamperedCall (): unknown {
      const context = vm.createContext({})
      // Compiled AS an https: URL itself, so every top-level statement here
      // -- including the final call -- already carries a real page frame,
      // with no nested script needed: a script's OWN frame is attributed to
      // where it was compiled, not to who runs it (this describe block's
      // own header).
      const script = new vm.Script(`
        ${FAKE_BRIDGE_SRC}
        const installOrivon = ${installOrivon.toString()}
        const target = {}
        installOrivon(fakeBridge(), ${JSON.stringify(LIMITS)}, target)
        // orivon:locked-global -- this Error is the throwaway vm realm's own, simulating a tampering extension under test, never a real page's global
        Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false })
        target.orivon.app.manifest()
      `, { filename: 'https://orivon-test.example/app.js' })
      return script.runInContext(context)
    }

    it('a frozen Error.prepareStackTrace refuses every call, even one with a real page frame -- proven in an isolated realm, the real Error untouched', async () => {
      await expect(tamperedCall()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    })

    it('did not touch this process\'s own Error.prepareStackTrace', () => {
      expect(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')?.configurable).not.toBe(false)
    })

    // Guards: a naive check that treats ONLY a freeze at exactly 0 as tamper
    // would pass a stackTraceLimit frozen at a small NON-ZERO value (1)
    // unrefused. The real rule: any limit that cannot be raised to Infinity
    // is a tamper, whatever value it was frozen at.
    function stackLimitTamperedCall (): unknown {
      const context = vm.createContext({})
      const script = new vm.Script(`
        ${FAKE_BRIDGE_SRC}
        const installOrivon = ${installOrivon.toString()}
        const target = {}
        installOrivon(fakeBridge(), ${JSON.stringify(LIMITS)}, target)
        // orivon:locked-global -- this Error is the throwaway vm realm's own, simulating a tampering extension under test, never a real page's global
        Object.defineProperty(Error, 'stackTraceLimit', { value: 1, writable: false, configurable: false })
        target.orivon.app.manifest()
      `, { filename: 'https://orivon-test.example/app.js' })
      return script.runInContext(context)
    }

    it('a stackTraceLimit frozen at a small NON-ZERO value (1) refuses too -- not just a freeze at 0', async () => {
      await expect(stackLimitTamperedCall()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    })

    // Bypass: CallSite.prototype methods read live -- main-world code that
    // obtains a CallSite (its own prepareStackTrace) can replace
    // getFileName on the shared prototype to report a page URL for a frame
    // that is really an extension's. Fixed: installOrivon saves references
    // to these methods AT INSTALL, before this tamper runs, and always
    // calls those; a live/saved mismatch is itself treated as tamper.
    function callSitePrototypeTamperedCall (): unknown {
      const context = vm.createContext({})
      // Compiled as chrome-extension:, so the bare (untampered) rule would
      // already refuse it on isExtension alone -- the point of this test is
      // that the tamper cannot flip that outcome to 'allowed' by making
      // getFileName() lie and report a page URL instead.
      const script = new vm.Script(`
        ${FAKE_BRIDGE_SRC}
        const installOrivon = ${installOrivon.toString()}
        const target = {}
        installOrivon(fakeBridge(), ${JSON.stringify(LIMITS)}, target)
        const holder = {}
        const savedPrepare = Error.prepareStackTrace
        Error.prepareStackTrace = (_e, s) => s
        Error.captureStackTrace(holder)
        Object.getPrototypeOf(holder.stack[0]).getFileName = () => 'https://spoofed.example/page.js'
        Error.prepareStackTrace = savedPrepare
        target.orivon.app.manifest()
      `, { filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js' })
      return script.runInContext(context)
    }

    it('a CallSite.prototype.getFileName replaced after install cannot spoof a page URL for an extension frame', async () => {
      await expect(callSitePrototypeTamperedCall()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    })

    // Bypass: hasSource/callerIsRefused read String.prototype.indexOf/
    // startsWith and Array.prototype.some LIVE, called fresh on every call
    // rather than through a saved reference -- a MAIN-world extension
    // script running at document_start can patch those shared prototypes
    // before installOrivon's first real call, making its OWN
    // chrome-extension:// frame look like page code: indexOf patched to
    // always report "not found" defeats the CONTAINS-based extension
    // check, and startsWith patched to always return true then makes the
    // STARTS-WITH-based page check pass for that same frame. Fixed:
    // every intrinsic the decision path calls is saved at install, before
    // this tamper runs, and read only through those saved references.
    function corePrototypeTamperedCall (): unknown {
      const context = vm.createContext({})
      const script = new vm.Script(`
        ${FAKE_BRIDGE_SRC}
        const installOrivon = ${installOrivon.toString()}
        const target = {}
        installOrivon(fakeBridge(), ${JSON.stringify(LIMITS)}, target)
        // orivon:locked-global -- this vm realm's own prototypes, simulating a MAIN-world extension patching shared intrinsics after install, never the real process's own. Array.prototype.some is left native: forcing it would trip the fail-closed empty-frame path and mask the real bypass, which lives entirely in the CONTAINS/STARTS-WITH string checks below.
        String.prototype.indexOf = function () { return -1 }
        String.prototype.startsWith = function () { return true }
        String.prototype.lastIndexOf = function () { return -1 }
        String.prototype.slice = function () { return '' }
        RegExp.prototype.exec = function () { return null }
        target.orivon.app.manifest()
      `, { filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js' })
      return script.runInContext(context)
    }

    it('patching Array.prototype.some, String.prototype.indexOf/startsWith/lastIndexOf/slice and RegExp.prototype.exec after install cannot make an extension frame look like page code', async () => {
      await expect(corePrototypeTamperedCall()).rejects.toMatchObject({ name: 'OrivonError', code: 'denied' })
    })

    it('did not touch this process\'s own String/Array/RegExp prototypes', () => {
      expect('abc'.indexOf('b')).toBe(1)
      expect('abc'.startsWith('ab')).toBe(true)
      expect([1, 2].some((n) => n === 2)).toBe(true)
    })
  })
})
