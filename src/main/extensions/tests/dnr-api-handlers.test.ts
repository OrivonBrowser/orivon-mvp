import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { InstalledExtension } from '../registry.js'

// registerDnrApiHandlers pulls the engine from extensions-dnr.js and the
// registry from registry-runner.js -- both mocked here so this suite can
// drive the handlers against a fake engine/registry without a real
// session, the same shape as extension-host.test.ts's own header explains
// for the virtual-specifier mocks below.
const engine = {
  updateDynamicRules: vi.fn(),
  getDynamicRules: vi.fn(() => []),
  updateSessionRules: vi.fn(),
  getSessionRules: vi.fn(() => []),
  updateEnabledRulesets: vi.fn(),
  getEnabledRulesets: vi.fn(() => []),
  getAvailableStaticRuleCount: vi.fn(() => 5000),
  testMatch: vi.fn(() => []),
}

vi.mock('orivon:crx-extensions-router', () => ({ setPermissionCheck: vi.fn() }))
vi.mock('../extensions-dnr.js', () => ({
  getDnrEngine: vi.fn(() => engine),
  slotDirForLoadedExtension: vi.fn(() => undefined),
}))
vi.mock('../dnr/dnr-runner.js', () => ({
  writeDynamicRules: vi.fn(),
  writeEnabledRulesetOverride: vi.fn(),
}))

let registryEntries: InstalledExtension[] = []
vi.mock('../registry-runner.js', () => ({
  readRegistry: () => registryEntries,
}))

const { registerDnrApiHandlers } = await import('../dnr-api.js')

function extensionEntry(id: string, permissions: readonly string[]): InstalledExtension {
  return {
    id,
    name: id,
    version: '1.0.0',
    enabled: true,
    installedAt: 0,
    updatedAt: 0,
    source: { kind: 'unpacked', from: '/x' },
    updater: { kind: 'none', reason: 'test' },
    path: `/x/${id}`,
    stripped: { permissions, optionalPermissions: [], declarativeNetRequest: undefined },
  }
}

interface FakeRouter {
  handlers: Map<string, { callback: (event: any, ...args: any[]) => any, opts?: any }>
  apiHandler: () => (name: string, callback: any, opts?: any) => void
  sendEvent: ReturnType<typeof vi.fn>
}

function fakeRouter(): FakeRouter {
  const handlers = new Map<string, { callback: any, opts?: any }>()
  return {
    handlers,
    apiHandler: () => (name: string, callback: any, opts?: any) => { handlers.set(name, { callback, opts }) },
    sendEvent: vi.fn(),
  }
}

beforeEach(() => {
  registryEntries = []
  vi.clearAllMocks()
})

describe('registerDnrApiHandlers', () => {
  it('registers every declarativeNetRequest.* method', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    const names = [...router.handlers.keys()]
    for (const method of [
      'updateDynamicRules', 'getDynamicRules', 'updateSessionRules', 'getSessionRules',
      'updateEnabledRulesets', 'getEnabledRulesets', 'getAvailableStaticRuleCount',
      'isRegexSupported', 'setExtensionActionOptions', 'getMatchedRules', 'testMatchOutcome',
    ]) {
      expect(names).toContain(`declarativeNetRequest.${method}`)
    }
  })

  it('gates the ordinary methods on the declarativeNetRequest permission', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    expect(router.handlers.get('declarativeNetRequest.updateDynamicRules')?.opts).toEqual({ permission: 'declarativeNetRequest' })
  })

  it('updateDynamicRules calls the engine with the calling extension\'s id and validated options', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.updateDynamicRules')!
    handler.callback({ extension: { id: 'ext-1' } }, { addRules: [{ id: 1 }], garbage: true })
    expect(engine.updateDynamicRules).toHaveBeenCalledWith('ext-1', { addRules: [{ id: 1 }] })
  })

  it('isRegexSupported reports a syntax error for an invalid pattern, without throwing', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.isRegexSupported')!
    expect(handler.callback({ extension: { id: 'ext-1' } }, { regex: '(unclosed' })).toEqual({ isSupported: false, reason: 'syntaxError' })
    expect(handler.callback({ extension: { id: 'ext-1' } }, { regex: 'a.*b' })).toEqual({ isSupported: true })
  })

  it('getMatchedRules requires declarativeNetRequestFeedback, refusing an extension without it even though it holds plain declarativeNetRequest', () => {
    registryEntries = [extensionEntry('ext-1', ['declarativeNetRequest'])]
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.getMatchedRules')!
    expect(() => handler.callback({ extension: { id: 'ext-1' } }, {})).toThrow(/declarativeNetRequestFeedback/)
  })

  it('getMatchedRules succeeds once the extension holds declarativeNetRequestFeedback', () => {
    registryEntries = [extensionEntry('ext-1', ['declarativeNetRequest', 'declarativeNetRequestFeedback'])]
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.getMatchedRules')!
    expect(handler.callback({ extension: { id: 'ext-1' } }, {})).toEqual({ rulesMatchedInfo: [] })
  })

  it('the returned onRuleMatched fires onRuleMatchedDebug only for an extension holding declarativeNetRequestFeedback', () => {
    registryEntries = [
      extensionEntry('has-feedback', ['declarativeNetRequest', 'declarativeNetRequestFeedback']),
      extensionEntry('no-feedback', ['declarativeNetRequest']),
    ]
    const router = fakeRouter()
    const onRuleMatched = registerDnrApiHandlers(router as any, '/userdata')

    onRuleMatched(7, { extensionId: 'no-feedback', rulesetId: '_session', ruleId: 1 })
    expect(router.sendEvent).not.toHaveBeenCalled()

    onRuleMatched(7, { extensionId: 'has-feedback', rulesetId: '_session', ruleId: 1 })
    expect(router.sendEvent).toHaveBeenCalledWith(
      'has-feedback',
      'declarativeNetRequest.onRuleMatchedDebug',
      expect.objectContaining({ rule: { ruleId: 1, rulesetId: '_session' } })
    )
  })
})
