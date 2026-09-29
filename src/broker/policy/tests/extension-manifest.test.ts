import { describe, expect, it } from 'vitest'
import {
  describeExtensionInstall, describeHostAccess, describeStrippedPermissions, loadableManifest,
  GRANTED_APPS_CLAUSE, readExtensionManifest, updateRequiresConsent,
  type ExtensionManifestFacts, type StrippedRecord
} from '../extension-manifest.js'

describe('readExtensionManifest', () => {
  const VALID_MV3 = {
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0.0',
    host_permissions: ['https://*/*'],
    permissions: ['storage', 'scripting'],
    content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }]
  }

  const cases: ReadonlyArray<{ label: string, raw: unknown, wantOk: boolean, reason?: string }> = [
    { label: 'a well-formed MV3 manifest', raw: VALID_MV3, wantOk: true },
    { label: 'not an object', raw: 'not an object', wantOk: false, reason: 'manifest is not an object' },
    { label: 'an array (not a manifest object)', raw: [1, 2], wantOk: false, reason: 'manifest is not an object' },
    { label: 'null', raw: null, wantOk: false, reason: 'manifest is not an object' },
    {
      label: 'a bad manifest_version',
      raw: { ...VALID_MV3, manifest_version: 4 },
      wantOk: false,
      reason: 'manifest_version must be 2 or 3, got 4'
    },
    {
      label: 'a missing manifest_version',
      raw: { name: 'x', version: '1.0.0' },
      wantOk: false,
      reason: 'manifest_version must be 2 or 3, got undefined'
    },
    {
      label: 'a missing name',
      raw: { manifest_version: 3, version: '1.0.0' },
      wantOk: false,
      reason: 'missing or non-string name'
    },
    {
      label: 'a missing version',
      raw: { manifest_version: 3, name: 'x' },
      wantOk: false,
      reason: 'missing or non-string version'
    },
    {
      label: 'a version that is a path traversal attempt',
      raw: { manifest_version: 3, name: 'x', version: '../x' },
      wantOk: false,
      reason: 'version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got "../x"'
    },
    {
      label: 'a version smuggling a traversal segment past the first dot',
      raw: { manifest_version: 3, name: 'x', version: '1.0/../../x' },
      wantOk: false,
      reason: 'version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got "1.0/../../x"'
    },
    {
      label: 'a version with five dot-separated parts',
      raw: { manifest_version: 3, name: 'x', version: '1.0.0.0.0' },
      wantOk: false,
      reason: 'version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got "1.0.0.0.0"'
    },
    {
      label: 'a version part over 65535',
      raw: { manifest_version: 3, name: 'x', version: '65536' },
      wantOk: false,
      reason: 'version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got "65536"'
    },
    {
      label: 'a version part with a leading zero',
      raw: { manifest_version: 3, name: 'x', version: '01' },
      wantOk: false,
      reason: 'version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got "01"'
    },
    {
      label: 'a well-formed three-part version',
      raw: { manifest_version: 3, name: 'x', version: '1.2.3' },
      wantOk: true
    },
    {
      label: 'a bare zero version',
      raw: { manifest_version: 3, name: 'x', version: '0' },
      wantOk: true
    },
    {
      label: 'an orivon key, rejected not ignored',
      raw: { ...VALID_MV3, orivon: { permissions: ['self'] } },
      wantOk: false,
      reason: 'Orivon permissions are not supported yet'
    },
    {
      label: '__MSG_ names, kept as-is',
      raw: { ...VALID_MV3, name: '__MSG_extName__' },
      wantOk: true
    }
  ]

  it.each(cases)('$label', ({ raw, wantOk, reason }) => {
    const result = readExtensionManifest(raw)
    expect(result.ok).toBe(wantOk)
    if (!wantOk) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe(reason)
    }
  })

  it('collects hostPatterns from host_permissions, MV2 pattern entries in permissions, and content_scripts matches, sorted and unique', () => {
    const raw = {
      manifest_version: 2,
      name: 'MV2 fixture',
      version: '1.0.0',
      // MV2 mixes host-pattern-shaped entries directly into `permissions`
      // alongside ordinary API permission names.
      permissions: ['storage', '*://*.example.com/*', 'tabs'],
      content_scripts: [
        { matches: ['https://a.example/*'] },
        { matches: ['https://a.example/*', 'https://b.example/*'] }
      ]
    }
    const result = readExtensionManifest(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.facts.hostPatterns).toEqual(
      ['*://*.example.com/*', 'https://a.example/*', 'https://b.example/*'].sort()
    )
    expect(result.facts.apiPermissions).toEqual(['storage', 'tabs'])
  })

  it('reports mainWorldScripts only from content_scripts entries declaring world MAIN', () => {
    const raw = {
      manifest_version: 3,
      name: 'MAIN world fixture',
      version: '1.0.0',
      content_scripts: [
        { matches: ['<all_urls>'], js: ['isolated.js'] },
        { matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }
      ]
    }
    const result = readExtensionManifest(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.facts.mainWorldScripts).toEqual(['main.js'])
  })

  it('reports hasKey, updateUrl and usesScripting', () => {
    const raw = { ...VALID_MV3, key: 'base64key==', update_url: 'https://example.com/update.xml' }
    const result = readExtensionManifest(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.facts.hasKey).toBe(true)
      expect(result.facts.updateUrl).toBe('https://example.com/update.xml')
      expect(result.facts.usesScripting).toBe(true)
    }
  })
})

describe('readExtensionManifest against real extensions\' permission shapes', () => {
  // Only the permission-related keys, copied from the four unpacked
  // extensions measured for docs/planning/extensions-exploration.md
  // (uBOL Lite 2026.926.2202, Dark Reader 4.9.133, Bitwarden 2026.9.2,
  // MetaMask 13.50.0.0) -- everything else in each real manifest.json is
  // irrelevant to this file.
  const REAL_MANIFESTS: ReadonlyArray<{ label: string, raw: unknown, hostPatterns: readonly string[], mainWorldScripts: readonly string[] }> = [
    {
      label: 'uBOL Lite',
      raw: {
        manifest_version: 3,
        name: '__MSG_extName__',
        version: '2026.926.2202',
        host_permissions: ['<all_urls>'],
        permissions: ['activeTab', 'alarms', 'declarativeNetRequest', 'offscreen', 'scripting', 'storage', 'unlimitedStorage', 'userScripts'],
        declarative_net_request: { rule_resources: [{ id: 'ublock-filters', enabled: true, path: '/rulesets/main/ublock-filters.json' }] }
      },
      hostPatterns: ['<all_urls>'],
      mainWorldScripts: []
    },
    {
      label: 'Dark Reader',
      raw: {
        manifest_version: 3,
        name: 'Dark Reader',
        version: '4.9.133',
        host_permissions: ['*://*/*'],
        permissions: ['alarms', 'fontSettings', 'scripting', 'storage'],
        optional_permissions: ['contextMenus'],
        content_scripts: [
          { matches: ['<all_urls>'], js: ['inject/proxy.js'], world: 'MAIN' },
          { matches: ['<all_urls>'], js: ['inject/fallback.js', 'inject/index.js'], world: 'ISOLATED' }
        ]
      },
      hostPatterns: ['*://*/*', '<all_urls>'],
      mainWorldScripts: ['inject/proxy.js']
    },
    {
      label: 'Bitwarden',
      raw: {
        manifest_version: 3,
        name: '__MSG_extName__',
        version: '2026.9.2',
        host_permissions: ['https://*/*', 'http://*/*'],
        permissions: ['activeTab', 'alarms', 'clipboardRead', 'clipboardWrite', 'contextMenus', 'idle', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage', 'webNavigation', 'webRequest', 'webRequestAuthProvider', 'notifications'],
        optional_permissions: ['nativeMessaging', 'privacy'],
        content_scripts: [{ matches: ['*://*/*', 'file:///*'], js: ['content/content-message-handler.js'] }]
      },
      hostPatterns: ['*://*/*', 'file:///*', 'http://*/*', 'https://*/*'],
      mainWorldScripts: []
    },
    {
      label: 'MetaMask',
      raw: {
        manifest_version: 3,
        name: '__MSG_appName__',
        version: '13.50.0.0',
        host_permissions: ['http://localhost:8545/', 'file://*/*', 'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
        permissions: ['activeTab', 'alarms', 'clipboardWrite', 'notifications', 'scripting', 'storage', 'unlimitedStorage', 'webRequest', 'offscreen', 'identity', 'sidePanel', 'cookies'],
        optional_permissions: ['clipboardRead'],
        content_scripts: [
          { matches: ['file://*/*', 'http://*/*', 'https://*/*'], js: ['scripts/contentscript.js'] },
          { matches: ['file://*/*', 'http://*/*', 'https://*/*'], js: ['scripts/inpage.js'], world: 'MAIN' }
        ]
      },
      hostPatterns: ['file://*/*', 'http://*/*', 'http://localhost:8545/', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      mainWorldScripts: ['scripts/inpage.js']
    }
  ]

  it.each(REAL_MANIFESTS)('$label parses to facts, with the measured hostPatterns and mainWorldScripts', ({ raw, hostPatterns, mainWorldScripts }) => {
    const result = readExtensionManifest(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.facts.hostPatterns).toEqual([...hostPatterns].sort())
    expect(result.facts.mainWorldScripts).toEqual(mainWorldScripts)
  })

  it('strips webRequest*, declarativeNetRequest* and nativeMessaging from every real manifest that declares them', () => {
    for (const { raw } of REAL_MANIFESTS) {
      const parsed = readExtensionManifest(raw)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      const { manifest, stripped } = loadableManifest(raw as Record<string, unknown>)
      const permissions = [...(manifest.permissions as string[] ?? []), ...(manifest.optional_permissions as string[] ?? [])]
      expect(permissions.some((p) => p === 'nativeMessaging' || p.startsWith('webRequest') || p.startsWith('declarativeNetRequest'))).toBe(false)
      expect(manifest.declarative_net_request).toBeUndefined()
      if ((raw as Record<string, unknown>).declarative_net_request !== undefined) {
        expect(stripped.declarativeNetRequest).toEqual((raw as Record<string, unknown>).declarative_net_request)
      }
    }
  })
})

describe('loadableManifest', () => {
  it('strips nativeMessaging and every webRequest*/declarativeNetRequest* permission from both lists, and moves declarative_net_request out', () => {
    const raw = {
      manifest_version: 3,
      name: 'x',
      version: '1.0.0',
      permissions: ['storage', 'webRequest', 'declarativeNetRequestWithHostAccess', 'nativeMessaging'],
      optional_permissions: ['webRequestBlocking', 'clipboardRead'],
      declarative_net_request: { rule_resources: [] }
    }
    const { manifest, stripped } = loadableManifest(raw)
    expect(manifest.permissions).toEqual(['storage'])
    expect(manifest.optional_permissions).toEqual(['clipboardRead'])
    expect(manifest.declarative_net_request).toBeUndefined()
    expect(stripped.permissions).toEqual(['webRequest', 'declarativeNetRequestWithHostAccess', 'nativeMessaging'])
    expect(stripped.optionalPermissions).toEqual(['webRequestBlocking'])
    expect(stripped.declarativeNetRequest).toEqual({ rule_resources: [] })
  })

  it('leaves a manifest with none of the stripped permissions unchanged, recording nothing removed', () => {
    const raw = { manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['storage'] }
    const { manifest, stripped } = loadableManifest(raw)
    expect(manifest.permissions).toEqual(['storage'])
    expect(stripped.permissions).toEqual([])
    expect(stripped.optionalPermissions).toEqual([])
    expect(stripped.declarativeNetRequest).toBeUndefined()
  })

  it('does not add permissions/optional_permissions keys that were absent on the way in', () => {
    const raw = { manifest_version: 3, name: 'x', version: '1.0.0' }
    const { manifest } = loadableManifest(raw)
    expect(Object.hasOwn(manifest, 'permissions')).toBe(false)
    expect(Object.hasOwn(manifest, 'optional_permissions')).toBe(false)
  })
})

function factsOf (raw: unknown): ExtensionManifestFacts {
  const result = readExtensionManifest(raw)
  if (!result.ok) throw new Error(`expected valid manifest: ${result.reason}`)
  return result.facts
}

describe('describeExtensionInstall', () => {
  it('says Chrome\'s own all-sites line and adds the Web3 line for <all_urls>', () => {
    const facts = factsOf({ manifest_version: 3, name: 'AllSites', version: '1.0.0', host_permissions: ['<all_urls>'] })
    const description = describeExtensionInstall(facts, 'unpacked')
    expect(description.detail).toContain('Read and change all your data on all websites')
    expect(description.detail).toContain('It also runs on Web3 sites and on apps you have given permissions to, except an app running from its pinned copy. Orivon keeps its code from using the permissions you have given those apps.')
    expect(description.warning).toBe(true)
  })

  it('lists specific hosts, first five then "and N more", when access is not all-sites', () => {
    const hosts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((h) => `https://${h}.example/*`)
    const facts = factsOf({ manifest_version: 3, name: 'SomeSites', version: '1.0.0', host_permissions: hosts })
    const description = describeExtensionInstall(facts, 'unpacked')
    expect(description.detail).toContain('Read and change your data on these sites:')
    expect(description.detail).toContain('and 2 more')
    expect(description.warning).toBe(false)
  })

  it('adds no host-access or Web3 line for an extension with no host access', () => {
    const facts = factsOf({ manifest_version: 3, name: 'NoHosts', version: '1.0.0' })
    const description = describeExtensionInstall(facts, 'unpacked')
    expect(description.detail).not.toContain('Web3')
    expect(description.detail).toBe('')
  })

  it('shows one "Read your browsing history" line even when both tabs and webNavigation are declared', () => {
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['tabs', 'webNavigation'] })
    const description = describeExtensionInstall(facts, 'unpacked')
    const occurrences = description.detail.split('Read your browsing history').length - 1
    expect(occurrences).toBe(1)
  })

  it('names what Orivon does not yet run when network permissions were stripped, and what it cannot do when nativeMessaging was stripped', () => {
    // describeExtensionInstall itself takes facts, not stripped -- install-runner.ts
    // is where the stripped-permission sentences actually get appended, since
    // they depend on loadableManifest's own output rather than the raw facts.
    // This test only proves the two "when present" API-permission lines it does
    // read straight off facts render as expected; the stripped-permission
    // sentences are covered where install-runner.ts assembles the full prompt.
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['downloads', 'debugger'] })
    const description = describeExtensionInstall(facts, 'unpacked')
    expect(description.detail).toContain('Manage your downloads')
    expect(description.detail).toContain('Access the page debugger backend')
  })

  it.each([
    ['unpacked', 'Load "x"?'],
    ['file', 'Install "x"?'],
    ['store', 'Add "x" to Orivon?']
  ] as const)('titles a %s install as %s', (source, title) => {
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0' })
    expect(describeExtensionInstall(facts, source).title).toBe(title)
  })

  it('builds its Web3 line from the same clause describeHostAccess-adjacent callers reuse', () => {
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['<all_urls>'] })
    expect(describeExtensionInstall(facts, 'unpacked').detail).toContain(`and on ${GRANTED_APPS_CLAUSE}.`)
  })
})

describe('describeHostAccess', () => {
  it('is undefined with no host access', () => {
    expect(describeHostAccess(factsOf({ manifest_version: 3, name: 'x', version: '1.0.0' }))).toBeUndefined()
  })

  it('matches describeExtensionInstall\'s own all-sites line, word for word', () => {
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['<all_urls>'] })
    const line = describeHostAccess(facts)
    expect(line).toBe('Read and change all your data on all websites')
    expect(describeExtensionInstall(facts, 'unpacked').detail).toContain(line as string)
  })

  it('matches describeExtensionInstall\'s own specific-hosts line, word for word', () => {
    const facts = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://example.com/*'] })
    const line = describeHostAccess(facts)
    expect(line).toBe('Read and change your data on these sites: example.com')
    expect(describeExtensionInstall(facts, 'unpacked').detail).toContain(line as string)
  })
})

describe('describeStrippedPermissions', () => {
  const EMPTY: StrippedRecord = { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }

  it('is empty when nothing was stripped', () => {
    expect(describeStrippedPermissions(EMPTY)).toEqual([])
  })

  it('names network blocking rules for a webRequest or declarativeNetRequest permission, from either list', () => {
    expect(describeStrippedPermissions({ ...EMPTY, permissions: ['webRequest'] })).toEqual(['Network blocking rules: Orivon does not run these yet'])
    expect(describeStrippedPermissions({ ...EMPTY, optionalPermissions: ['declarativeNetRequestWithHostAccess'] }))
      .toEqual(['Network blocking rules: Orivon does not run these yet'])
  })

  it('names network blocking rules when only the declarative_net_request key was stripped', () => {
    expect(describeStrippedPermissions({ ...EMPTY, declarativeNetRequest: { rule_resources: [] } }))
      .toEqual(['Network blocking rules: Orivon does not run these yet'])
  })

  it('names native messaging for a stripped nativeMessaging permission', () => {
    expect(describeStrippedPermissions({ ...EMPTY, permissions: ['nativeMessaging'] }))
      .toEqual(['Talking to programs on your computer: not available in Orivon'])
  })

  it('names both, in order, when both were stripped', () => {
    expect(describeStrippedPermissions({ ...EMPTY, permissions: ['webRequest', 'nativeMessaging'] })).toEqual([
      'Network blocking rules: Orivon does not run these yet',
      'Talking to programs on your computer: not available in Orivon'
    ])
  })
})

describe('updateRequiresConsent', () => {
  it('is false when the update declares nothing new', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://a.example/*'], permissions: ['storage'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', host_permissions: ['https://a.example/*'], permissions: ['storage'] })
    expect(updateRequiresConsent(previous, next)).toBe(false)
  })

  it('is true when hostPatterns widens beyond an exact subset', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://a.example/*'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', host_permissions: ['https://a.example/*', 'https://b.example/*'] })
    expect(updateRequiresConsent(previous, next)).toBe(true)
  })

  it('is false when hostPatterns only narrows', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', host_permissions: ['https://a.example/*', 'https://b.example/*'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', host_permissions: ['https://a.example/*'] })
    expect(updateRequiresConsent(previous, next)).toBe(false)
  })

  it('is true when a new API permission with a warning line is added', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['storage'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', permissions: ['storage', 'tabs'] })
    expect(updateRequiresConsent(previous, next)).toBe(true)
  })

  it('is false when a new API permission carries no warning line', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['storage'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', permissions: ['storage', 'alarms'] })
    expect(updateRequiresConsent(previous, next)).toBe(false)
  })

  it('is false when a warning permission is only added to optional_permissions, not permissions', () => {
    const previous = factsOf({ manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['storage'] })
    const next = factsOf({ manifest_version: 3, name: 'x', version: '1.0.1', permissions: ['storage'], optional_permissions: ['tabs'] })
    expect(updateRequiresConsent(previous, next)).toBe(false)
  })
})
