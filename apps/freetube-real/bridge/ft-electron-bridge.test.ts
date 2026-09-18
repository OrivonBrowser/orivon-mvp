// Unit coverage for every one of the 34 `window.ftElectron` members
// ft-electron-bridge.js installs -- freetube-bridge-spec.md's own list, read
// against every call site in the clone's src/renderer.
//
// NOT PICKED UP BY `npm test` YET, same as apps/fixture/manifest.test.ts:
// vitest.config.ts's include pattern is `src/**/*.test.ts` and
// `scripts/**/*.test.ts`, and apps/freetube-real/ is neither. Run directly
// with `npx vitest run apps/freetube-real/bridge/ft-electron-bridge.test.ts`.
//
// The bridge is a classic script with no module exports (it has to run
// before FreeTube's own bundle, as a plain <script> tag), so each test loads
// its source into a fresh `vm` context carrying fake `window`/`document`/
// `navigator`/`fetch`, exactly as a browser would provide them, and drives
// the internals the script exposes for this purpose only
// (`globalThis.__ftElectronBridgeInternals`).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const SOURCE = readFileSync(fileURLToPath(new URL('./ft-electron-bridge.js', import.meta.url)), 'utf8')

interface FakeDocument {
  title: string
  documentElement: { style: Record<string, string>, requestFullscreen: () => Promise<void> }
  querySelector: (selector: string) => { requestPictureInPicture: () => Promise<void> } | null
}

interface Sandbox {
  window: { orivon?: Record<string, unknown> }
  document: FakeDocument
  navigator: { language: string, wakeLock?: { request: (kind: string) => Promise<{ release: () => Promise<void> }> } }
  fetch: (input: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>
  // generatePoToken's own per-attempt deadline (attemptMintOnce) needs real
  // globals here -- a `vm` context gets V8's own built-ins (Promise, Symbol,
  // ...) for free, but NOT Node's globals, `setTimeout`/`clearTimeout`
  // included. Forwarding to the OUTER `globalThis` rather than binding the
  // function values once means these keep working after a test calls
  // `vi.useFakeTimers()`, which replaces what `globalThis.setTimeout` points
  // to -- a value captured before that call would still be the real one.
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  __ftElectronBridgeInternals?: {
    installFtElectronBridge: (getOrivon: () => Record<string, unknown> | undefined) => { bridge: Record<string, any>, recordedListeners: Record<string, unknown> }
    FtBridgeError: new (member: string, reason: string, detail?: string) => Error & { member: string, reason: string }
    rewriteBotGuardScript: (script: string, videoId: string, context: string, attestation: string, ytConfig: string) => string
    PoTokenMintStalledError: new (attempts: number) => Error & { attempts: number }
    MINT_ATTEMPT_DEADLINE_MS: number
    MINT_MAX_ATTEMPTS: number
  }
}

function fakeDocument (overrides: Partial<FakeDocument> = {}): FakeDocument {
  return {
    title: 'FreeTube',
    documentElement: { style: {}, requestFullscreen: async () => {} },
    querySelector: () => null,
    ...overrides
  }
}

/** Runs the bridge's own source in a fresh realm, so each test starts from a clean window.ftElectron with no state left over from another test. */
function load (opts: { orivon?: Record<string, unknown>, document?: Partial<FakeDocument>, navigator?: Partial<Sandbox['navigator']>, fetch?: Sandbox['fetch'] } = {}): Sandbox {
  const sandbox = {
    window: { orivon: opts.orivon },
    document: fakeDocument(opts.document),
    navigator: { language: 'en-US', ...opts.navigator },
    fetch: opts.fetch ?? (async () => { throw new Error('fetch not stubbed for this test') }),
    setTimeout: ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout,
    clearTimeout: ((...args: Parameters<typeof clearTimeout>) => { globalThis.clearTimeout(...args) }) as typeof clearTimeout
  } as Sandbox
  vm.createContext(sandbox as unknown as object)
  vm.runInContext(SOURCE, sandbox as unknown as object, { filename: 'ft-electron-bridge.js' })
  return sandbox
}

function internals (sandbox: Sandbox): NonNullable<Sandbox['__ftElectronBridgeInternals']> {
  const found = sandbox.__ftElectronBridgeInternals
  if (found === undefined) throw new Error('bridge did not expose __ftElectronBridgeInternals')
  return found
}

function freshBridge (opts: Parameters<typeof load>[0] = {}) {
  const sandbox = load(opts)
  return { sandbox, ...internals(sandbox).installFtElectronBridge(() => sandbox.window.orivon) }
}

describe('web platform group', () => {
  it('requestFullscreen calls document.documentElement.requestFullscreen()', async () => {
    const requestFullscreen = vi.fn(async () => {})
    const { bridge } = freshBridge({ document: { documentElement: { style: {}, requestFullscreen } } })
    await bridge.requestFullscreen()
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('requestFullscreen still surfaces a rejection to its own caller (only unawaited call sites are shielded)', async () => {
    const requestFullscreen = async () => { throw new Error('no user gesture') }
    const { bridge } = freshBridge({ document: { documentElement: { style: {}, requestFullscreen } } })
    await expect(bridge.requestFullscreen()).rejects.toThrow('no user gesture')
  })

  it('requestPiP calls requestPictureInPicture on the one <video> element', async () => {
    const requestPictureInPicture = vi.fn(async () => {})
    const { bridge } = freshBridge({ document: { querySelector: () => ({ requestPictureInPicture }) } })
    await bridge.requestPiP()
    expect(requestPictureInPicture).toHaveBeenCalledTimes(1)
  })

  it('requestPiP is a no-op when no <video> is mounted yet', async () => {
    const { bridge } = freshBridge()
    await expect(bridge.requestPiP()).resolves.toBeUndefined()
  })

  it('setZoomFactor writes the CSS zoom style as a string', () => {
    const { bridge, sandbox } = freshBridge()
    bridge.setZoomFactor(1.25)
    expect(sandbox.document.documentElement.style.zoom).toBe('1.25')
  })

  it('getSystemLocale returns navigator.language', () => {
    const { bridge } = freshBridge({ navigator: { language: 'it-IT' } })
    expect(bridge.getSystemLocale()).toBe('it-IT')
  })

  it('start/stopPowerSaveBlocker request and release a Screen Wake Lock', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }))
    const { bridge } = freshBridge({ navigator: { wakeLock: { request } } })
    await bridge.startPowerSaveBlocker()
    expect(request).toHaveBeenCalledWith('screen')
    await bridge.stopPowerSaveBlocker()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('start/stopPowerSaveBlocker degrade quietly with no Wake Lock API', async () => {
    const { bridge } = freshBridge()
    await expect(bridge.startPowerSaveBlocker()).resolves.toBeUndefined()
    await expect(bridge.stopPowerSaveBlocker()).resolves.toBeUndefined()
  })

  it('isWaylandPlatform is always false', () => {
    const { bridge } = freshBridge()
    expect(bridge.isWaylandPlatform()).toBe(false)
  })
})

describe('player cache group', () => {
  it('playerCacheGet/Set round-trip through an in-memory Map', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.playerCacheGet('missing')).toBeUndefined()
    await bridge.playerCacheSet('k', { streams: [1, 2] })
    expect(await bridge.playerCacheGet('k')).toEqual({ streams: [1, 2] })
  })
})

describe('downloads group', () => {
  it('chooseDefaultFolder refuses by name when there is no fs grant', async () => {
    const { bridge } = freshBridge({ orivon: {} })
    await expect(bridge.chooseDefaultFolder()).rejects.toMatchObject({ name: 'FtBridgeError', member: 'chooseDefaultFolder', reason: 'not-built' })
  })

  it('writeToDefaultFolder resolves false before a folder has been chosen', async () => {
    const { bridge } = freshBridge({ orivon: {} })
    expect(await bridge.writeToDefaultFolder('shot.png', new ArrayBuffer(2))).toBe(false)
  })

  it('chooseDefaultFolder picks via orivon.fs.userSelected, and writeToDefaultFolder writes into it', async () => {
    const writeFile = vi.fn(async () => {})
    const userSelected = vi.fn(async () => ({ writeFile }))
    const { bridge } = freshBridge({ orivon: { fs: { userSelected } } })

    await bridge.chooseDefaultFolder()
    expect(userSelected).toHaveBeenCalledWith({ directory: true })

    const bytes = new Uint8Array([1, 2, 3]).buffer
    const wrote = await bridge.writeToDefaultFolder('shot.png', bytes)
    expect(wrote).toBe(true)
    expect(writeFile).toHaveBeenCalledTimes(1)
    const [name, data] = writeFile.mock.calls[0] as [string, Uint8Array]
    expect(name).toBe('shot.png')
    expect(Array.from(data)).toEqual([1, 2, 3])
  })
})

describe('listeners group', () => {
  const names = [
    'handleChangeView', 'handleOpenUrl', 'handleUpdateSearchInputText', 'handleOpenInExternalPlayerResult',
    'handleSyncHistory', 'handleSyncPlaylists', 'handleSyncProfiles', 'handleSyncSearchHistory',
    'handleSyncSettings', 'handleSyncSubscriptionCache'
  ] as const

  it.each(names)('%s records the callback and never calls it', (name) => {
    const { bridge, recordedListeners } = freshBridge()
    const callback = vi.fn()
    bridge[name](callback)
    expect(recordedListeners[name]).toBe(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('handleUpdateSearchInputText also accepts null, as TopNav.vue unsubscribes with (App.vue keeps a live callback across route changes)', () => {
    const { bridge, recordedListeners } = freshBridge()
    expect(() => { bridge.handleUpdateSearchInputText(null) }).not.toThrow()
    expect(recordedListeners.handleUpdateSearchInputText).toBeNull()
  })
})

describe('session state group', () => {
  it('getNavigationHistory returns exactly one active entry labeled the current title', async () => {
    const { bridge } = freshBridge({ document: { title: 'Watch - FreeTube' } })
    const options = await bridge.getNavigationHistory()
    expect(options).toEqual([{ label: 'Watch - FreeTube', active: true, value: 0 }])
    // TopNav.vue's own call site: `dropdownOptions.find(option => option.active)` must never be undefined.
    expect(options.find((option: { active: boolean }) => option.active)).toBeDefined()
  })

  it('setInvidiousAuthorization/clearInvidiousAuthorization are no-ops', () => {
    const { bridge } = freshBridge()
    expect(bridge.setInvidiousAuthorization('token', 'https://inv.example')).toBeUndefined()
    expect(bridge.clearInvidiousAuthorization()).toBeUndefined()
  })

  it('getReplaceHttpCache/getDisableHardwareAcceleration resolve false, and their toggles are no-ops', async () => {
    const { bridge } = freshBridge()
    expect(await bridge.getReplaceHttpCache()).toBe(false)
    expect(await bridge.getDisableHardwareAcceleration()).toBe(false)
    expect(bridge.toggleReplaceHttpCache()).toBeUndefined()
    expect(bridge.toggleDisableHardwareAcceleration()).toBeUndefined()
  })
})

describe('refused by name group', () => {
  const cases: ReadonlyArray<[string, string, unknown[]]> = [
    ['openInExternalPlayer', 'excluded', [{ videoId: 'a' }]],
    ['relaunch', 'shell-owned', []],
    ['openInNewWindow', 'shell-owned', ['/watch/a', undefined, null]],
    ['enableProxy', 'shell-owned', ['socks5://127.0.0.1:9050']],
    ['disableProxy', 'shell-owned', []]
  ]

  it.each(cases)('%s throws a named FtBridgeError (%s)', (member, reason, args) => {
    const { bridge } = freshBridge()
    expect(() => bridge[member](...args)).toThrow(new RegExp(`ftElectron\\.${member} is unavailable`))
    try {
      bridge[member](...args)
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as { member: string }).member).toBe(member)
      expect((error as { reason: string }).reason).toBe(reason)
    }
  })
})

describe('generatePoToken (ADR-0019, web.context -- not implemented in this branch)', () => {
  it('rejects "not-built" when orivon.web is absent, without ever fetching botGuardScript.js', async () => {
    const fetchSpy = vi.fn()
    const { bridge } = freshBridge({ orivon: {}, fetch: fetchSpy })
    await expect(bridge.generatePoToken('id', '{}', '{}', '{}')).rejects.toMatchObject({
      name: 'FtBridgeError',
      member: 'generatePoToken',
      reason: 'not-built'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rewriteBotGuardScript splices the three JSON strings into the export tail, upstream-style', () => {
    const { sandbox } = freshBridge()
    const rewritten = internals(sandbox).rewriteBotGuardScript('var a=1;export{a as default};', 'vid', '{"c":1}', '{"a":2}', '{"y":3}')
    expect(rewritten).toBe('var a=1;;a("vid",{"c":1},{"a":2},{"y":3})')
  })

  it('rewriteBotGuardScript JSON-encodes a hostile video id instead of splicing it as a literal', () => {
    const { sandbox } = freshBridge()
    // A videoId crafted to break out of the naive `"${videoId}"` splice: were
    // it spliced raw, the `"` right after `#/watch/` would close the string
    // literal early and the rest would run as script inside the
    // youtube.com context.
    const hostileId = '");globalThis.pwned=true;("'
    const rewritten = internals(sandbox).rewriteBotGuardScript('var a=1;export{a as default};', hostileId, '{"c":1}', '{"a":2}', '{"y":3}')
    // JSON.stringify escapes every `"` in hostileId, so the whole payload
    // stays inside ONE string argument -- proven by executing the rewrite
    // for real and checking `a` receives it as a single string, not
    // multiple statements.
    expect(rewritten).toBe(`var a=1;;a(${JSON.stringify(hostileId)},{"c":1},{"a":2},{"y":3})`)
    const context: { received?: unknown[], pwned?: boolean } = {}
    vm.createContext(context)
    vm.runInContext('function a (...args) { received = args }', context)
    vm.runInContext(rewritten.replace('var a=1;', ''), context)
    expect(context.received).toEqual([hostileId, { c: 1 }, { a: 2 }, { y: 3 }])
    expect(context.pwned).toBeUndefined()
  })

  it('given a fake orivon.web, fetches the script once, opens a youtube.com context, evaluates the rewritten script, and always closes', async () => {
    const evaluate = vi.fn(async () => 'THE_TOKEN')
    const close = vi.fn(async () => {})
    const openContext = vi.fn(async () => ({ evaluate, close }))
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'var a=1;export{a as default};' }))
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })

    const token = await bridge.generatePoToken('vid', '{}', '{}', '{}')

    expect(token).toBe('THE_TOKEN')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(openContext).toHaveBeenCalledWith('https://www.youtube.com', { width: 1920, height: 1080 })
    expect(close).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenCalledWith('var a=1;;a("vid",{},{},{})')

    // Cached: a second mint does not re-fetch the script.
    await bridge.generatePoToken('vid2', '{}', '{}', '{}')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenLastCalledWith('var a=1;;a("vid2",{},{},{})')
  })

  it('closes the context even when evaluate throws, and does not retry a real rejection', async () => {
    const close = vi.fn(async () => {})
    const openContext = vi.fn(async () => ({ evaluate: async () => { throw new Error('bad token') }, close }))
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'export{x as default};' }))
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })

    // A script that ran and threw is not this attempt's own deadline (below)
    // -- retrying cannot fix it, so it propagates on the first attempt.
    await expect(bridge.generatePoToken('vid', '{}', '{}', '{}')).rejects.toThrow('bad token')
    expect(close).toHaveBeenCalledTimes(1)
    expect(openContext).toHaveBeenCalledTimes(1)
  })

  // PoToken stall investigation, Part B (apps/freetube-real/README.md): BotGuard's
  // own opaque snapshot step is observed to hang -- `evaluate` neither resolves
  // nor rejects -- roughly half the time under headless Xvfb with no real GPU.
  // These drive that exact shape: a fake `orivon.web` whose `evaluate` never
  // settles at all.
  describe('a stalled attempt (evaluate never settles)', () => {
    it('retries in a fresh context once an attempt exceeds its own deadline, and returns the next attempt\'s token', async () => {
      vi.useFakeTimers()
      try {
        const opened: number[] = []
        const closed: number[] = []
        let openCount = 0
        const openContext = vi.fn(async () => {
          const mine = ++openCount
          opened.push(mine)
          return {
            // The first context stalls forever; the second answers at once.
            evaluate: async () => mine === 1 ? await new Promise(() => {}) : 'TOKEN_FROM_ATTEMPT_2',
            close: async () => { closed.push(mine) }
          }
        })
        const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'export{x as default};' }))
        const { sandbox, bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })
        const { MINT_ATTEMPT_DEADLINE_MS } = internals(sandbox)

        const pending = bridge.generatePoToken('vid', '{}', '{}', '{}')
        const assertion = expect(pending).resolves.toBe('TOKEN_FROM_ATTEMPT_2')
        await vi.advanceTimersByTimeAsync(MINT_ATTEMPT_DEADLINE_MS + 1)
        await assertion

        expect(opened).toEqual([1, 2])
        // The stalled first context is closed (freeing its LIMITS.webContexts
        // slot) before the second one ever opens -- never both at once.
        expect(closed).toEqual([1, 2])
      } finally {
        vi.useRealTimers()
      }
    })

    it('gives up with a named, counted error once every attempt has stalled', async () => {
      vi.useFakeTimers()
      try {
        const closed: number[] = []
        let openCount = 0
        const openContext = vi.fn(async () => {
          const mine = ++openCount
          return { evaluate: async () => await new Promise(() => {}), close: async () => { closed.push(mine) } }
        })
        const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'export{x as default};' }))
        const { sandbox, bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })
        const { MINT_ATTEMPT_DEADLINE_MS, MINT_MAX_ATTEMPTS, PoTokenMintStalledError } = internals(sandbox)

        const pending = bridge.generatePoToken('vid', '{}', '{}', '{}')
        const assertion = expect(pending).rejects.toMatchObject({ name: 'PoTokenMintStalledError', attempts: MINT_MAX_ATTEMPTS })
        for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt += 1) {
          await vi.advanceTimersByTimeAsync(MINT_ATTEMPT_DEADLINE_MS + 1)
        }
        await assertion

        expect(openContext).toHaveBeenCalledTimes(MINT_MAX_ATTEMPTS)
        expect(closed).toHaveLength(MINT_MAX_ATTEMPTS)
        await expect(pending).rejects.toBeInstanceOf(PoTokenMintStalledError)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('queues mints one at a time, as poTokenGenerator.js does', async () => {
    const order: string[] = []
    let openCount = 0
    const openContext = vi.fn(async () => {
      const mine = ++openCount
      order.push(`open${String(mine)}`)
      return {
        evaluate: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return `token${String(mine)}` },
        close: async () => { order.push(`close${String(mine)}`) }
      }
    })
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'export{x as default};' }))
    const { bridge } = freshBridge({ orivon: { web: { openContext } }, fetch: fetchSpy })

    const [first, second] = await Promise.all([
      bridge.generatePoToken('a', '{}', '{}', '{}'),
      bridge.generatePoToken('b', '{}', '{}', '{}')
    ])

    expect(first).toBe('token1')
    expect(second).toBe('token2')
    // The second mint's context never opens until the first one has closed.
    expect(order).toEqual(['open1', 'close1', 'open2', 'close2'])
  })
})
