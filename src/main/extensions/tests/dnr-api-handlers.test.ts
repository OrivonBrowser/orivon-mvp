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
let registryEntries: InstalledExtension[] = []
vi.mock('../extensions-dnr.js', () => ({
  getDnrEngine: vi.fn(() => engine),
  slotDirForLoadedExtension: vi.fn(() => undefined),
  // dnr-api.ts reads permissions from extensions-dnr.ts's own load-time
  // cache, not registry.json, now (finding 6's per-match disk read): faked
  // here from the same registryEntries a test sets, standing in for "what
  // the cache would hold once this extension loaded".
  getCachedStrippedPermissions: (id: string) => registryEntries.find((entry) => entry.id === id)?.stripped.permissions ?? [],
}))
vi.mock('../dnr/dnr-runner.js', () => ({
  writeDynamicRules: vi.fn(),
  writeEnabledRulesetOverride: vi.fn(),
}))

const { registerDnrApiHandlers } = await import('../dnr-api.js')
const { clearExtensionMatchLog } = await import('../dnr-match-log.js')

// dnr-match-log.js is real here (not mocked): its badge-enabled flag and
// action counts are process-lifetime state, so every extension id any test
// below uses gets cleared first -- otherwise a later test's
// setExtensionActionOptions/onRuleMatched calls would see a PRIOR test's
// leftover state for the same id.
const TEST_EXTENSION_IDS = ['ext-1', 'has-feedback', 'no-feedback', 'watches', 'quiet']

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

function fakeBadgeHost(): { setBadgeText: ReturnType<typeof vi.fn<(extensionId: string, tabId: number, text: string) => void>> } {
  return { setBadgeText: vi.fn() }
}

beforeEach(() => {
  registryEntries = []
  vi.clearAllMocks()
  for (const id of TEST_EXTENSION_IDS) {
    clearExtensionMatchLog(id)
  }
})

describe('registerDnrApiHandlers', () => {
  it('registers every declarativeNetRequest.* method', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
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
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
    expect(router.handlers.get('declarativeNetRequest.updateDynamicRules')?.opts).toEqual({ permission: 'declarativeNetRequest' })
  })

  it('updateDynamicRules calls the engine with the calling extension\'s id and validated options', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.updateDynamicRules')!
    handler.callback({ extension: { id: 'ext-1' } }, { addRules: [{ id: 1 }], garbage: true })
    expect(engine.updateDynamicRules).toHaveBeenCalledWith('ext-1', { addRules: [{ id: 1 }] })
  })

  it('isRegexSupported reports a syntax error for an invalid pattern, without throwing', () => {
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.isRegexSupported')!
    expect(handler.callback({ extension: { id: 'ext-1' } }, { regex: '(unclosed' })).toEqual({ isSupported: false, reason: 'syntaxError' })
    expect(handler.callback({ extension: { id: 'ext-1' } }, { regex: 'a.*b' })).toEqual({ isSupported: true })
  })

  it('getMatchedRules requires declarativeNetRequestFeedback, refusing an extension without it even though it holds plain declarativeNetRequest', () => {
    registryEntries = [extensionEntry('ext-1', ['declarativeNetRequest'])]
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.getMatchedRules')!
    expect(() => handler.callback({ extension: { id: 'ext-1' } }, {})).toThrow(/declarativeNetRequestFeedback/)
  })

  it('getMatchedRules succeeds once the extension holds declarativeNetRequestFeedback', () => {
    registryEntries = [extensionEntry('ext-1', ['declarativeNetRequest', 'declarativeNetRequestFeedback'])]
    const router = fakeRouter()
    registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')
    const handler = router.handlers.get('declarativeNetRequest.getMatchedRules')!
    expect(handler.callback({ extension: { id: 'ext-1' } }, {})).toEqual({ rulesMatchedInfo: [] })
  })

  it('the returned onRuleMatched fires onRuleMatchedDebug only for an extension holding declarativeNetRequestFeedback', () => {
    registryEntries = [
      extensionEntry('has-feedback', ['declarativeNetRequest', 'declarativeNetRequestFeedback']),
      extensionEntry('no-feedback', ['declarativeNetRequest']),
    ]
    const router = fakeRouter()
    const { onRuleMatched } = registerDnrApiHandlers(router as any, fakeBadgeHost(), '/userdata')

    onRuleMatched(7, { extensionId: 'no-feedback', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    expect(router.sendEvent).not.toHaveBeenCalled()

    onRuleMatched(7, { extensionId: 'has-feedback', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    expect(router.sendEvent).toHaveBeenCalledWith(
      'has-feedback',
      'declarativeNetRequest.onRuleMatchedDebug',
      expect.objectContaining({ rule: { ruleId: 1, rulesetId: '_session' } })
    )
  })

  it('onRuleMatched sets the tab\'s badge text to the running count, only once badge-count mode is on', () => {
    registryEntries = [extensionEntry('ext-1', ['declarativeNetRequest'])]
    const router = fakeRouter()
    const badgeHost = fakeBadgeHost()
    const { onRuleMatched } = registerDnrApiHandlers(router as any, badgeHost, '/userdata')

    onRuleMatched(7, { extensionId: 'ext-1', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    expect(badgeHost.setBadgeText).not.toHaveBeenCalled()

    const setExtensionActionOptions = router.handlers.get('declarativeNetRequest.setExtensionActionOptions')!
    setExtensionActionOptions.callback({ extension: { id: 'ext-1' } }, { displayActionCountAsBadgeText: true })

    onRuleMatched(7, { extensionId: 'ext-1', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    onRuleMatched(7, { extensionId: 'ext-1', rulesetId: '_session', ruleId: 2, actionType: 'block' })
    expect(badgeHost.setBadgeText).toHaveBeenNthCalledWith(1, 'ext-1', 7, '1')
    expect(badgeHost.setBadgeText).toHaveBeenNthCalledWith(2, 'ext-1', 7, '2')
  })

  it('onTabNavigated blanks the badge of every extension in badge-count mode for that tab, leaves others alone', () => {
    registryEntries = [
      extensionEntry('watches', ['declarativeNetRequest']),
      extensionEntry('quiet', ['declarativeNetRequest']),
    ]
    const router = fakeRouter()
    const badgeHost = fakeBadgeHost()
    const { onRuleMatched, onTabNavigated } = registerDnrApiHandlers(router as any, badgeHost, '/userdata')
    const setExtensionActionOptions = router.handlers.get('declarativeNetRequest.setExtensionActionOptions')!
    setExtensionActionOptions.callback({ extension: { id: 'watches' } }, { displayActionCountAsBadgeText: true })

    onRuleMatched(7, { extensionId: 'watches', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    badgeHost.setBadgeText.mockClear()

    onTabNavigated(7)
    expect(badgeHost.setBadgeText).toHaveBeenCalledTimes(1)
    expect(badgeHost.setBadgeText).toHaveBeenCalledWith('watches', 7, '')

    // The running count really is reset, not just the badge display: the
    // next match on this tab starts back at "1".
    onRuleMatched(7, { extensionId: 'watches', rulesetId: '_session', ruleId: 1, actionType: 'block' })
    expect(badgeHost.setBadgeText).toHaveBeenLastCalledWith('watches', 7, '1')
  })
})
