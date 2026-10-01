// The two places a feature plugs into the extensions page's main side: parts
// merged into the list and details replies, and requests beyond the core ones.
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'

const received: Array<{ body: unknown, deps: unknown }> = []

vi.mock('../extensions-detail-parts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../extensions-detail-parts.js')>()
  return {
    ...original,
    ROW_PARTS: [(entry: InstalledExtension) => ({ errors: { count: entry.name.length } })],
    DETAIL_PARTS: [() => ({ pins: { pinned: true } }), () => ({ shortcuts: { count: 2 } })]
  }
})
vi.mock('../extensions-page-commands.js', () => ({
  EXTENSION_PAGE_COMMANDS: {
    echo: (body: unknown, deps: unknown) => { received.push({ body, deps }); return { echoed: true } }
  }
}))

const { extensionsDomain } = await import('../extensions-domain.js')

const ENTRY: InstalledExtension = {
  id: 'abcdefghijklmnopabcdefghijklmnop',
  name: 'Fixture',
  version: '1.0.0',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  source: { kind: 'unpacked', from: '/x' },
  updater: { kind: 'none', reason: 'none' },
  path: '/userData/extensions/u-aaaa/1.0.0',
  stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
}
const FACTS: ExtensionFacts = { resolvedName: 'Fixture', resolvedDescription: undefined, iconDataUrl: undefined, manifestFacts: undefined }
const caller = { page: 'extensions' as const, contents: {} as WebContents }

function deps (): ExtensionsDomainDeps {
  return {
    extensions: { list: () => [ENTRY] } as unknown as ExtensionsDomainDeps['extensions'],
    prefs: createExtensionPrefsStore(null),
    host: () => undefined,
    shell: {} as ShellServices,
    isPrivate: false,
    readFacts: async () => FACTS,
    developerModeEnabled: () => false,
    pickFolder: async () => undefined,
    pickFile: async () => undefined,
    notify: () => {}
  }
}

describe('extensionsDomain extension points', () => {
  it('merges every row part into each list row', async () => {
    const reply = await extensionsDomain(deps()).handle({ type: 'list' }, caller) as { rows: Array<{ parts: object }> }
    expect(reply.rows[0]?.parts).toEqual({ errors: { count: 7 } })
  })

  it('merges every detail part into the details reply, and the row parts into its row', async () => {
    const reply = await extensionsDomain(deps()).handle({ type: 'details', id: ENTRY.id }, caller) as { details: { parts: object, row: { parts: object } } }
    expect(reply.details.parts).toEqual({ pins: { pinned: true }, shortcuts: { count: 2 } })
    expect(reply.details.row.parts).toEqual({ errors: { count: 7 } })
  })

  it('hands a request it does not know to the page command of that name, with the body and the deps', async () => {
    const d = deps()
    expect(await extensionsDomain(d).handle({ type: 'echo', id: 'x' }, caller)).toEqual({ echoed: true })
    expect(received[0]).toEqual({ body: { type: 'echo', id: 'x' }, deps: d })
  })

  it('does not run a command through a prototype name', async () => {
    const handle = extensionsDomain(deps()).handle
    expect(await handle({ type: 'toString' }, caller)).toBeUndefined()
    expect(await handle({ type: '__proto__' }, caller)).toBeUndefined()
  })
})
