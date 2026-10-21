import { describe, expect, it, vi } from 'vitest'
import { mediaPart, setMedia } from '../details-media.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'

const ID = 'a'.repeat(32)
const entry = { id: ID } as InstalledExtension
const facts = {} as ExtensionFacts

function deps () {
  const prefs = createExtensionPrefsStore(null)
  const changed = vi.fn()
  prefs.onChange(changed)
  const value = { prefs, extensions: { list: () => [entry] } } as unknown as ExtensionsDomainDeps
  return { prefs, changed, deps: value }
}

describe('mediaPart', () => {
  it('is empty until the person has answered for a device', () => {
    expect(mediaPart(entry, facts, deps().deps)).toEqual({})
  })

  it('lists only the devices with an answer, in words, camera first', () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { media: { microphone: 'allow', camera: 'block' } })
    expect(mediaPart(entry, facts, value)).toEqual({
      media: { rows: [{ kind: 'camera', label: 'Camera', value: 'block' }, { kind: 'microphone', label: 'Microphone', value: 'allow' }] }
    })
    prefs.update(ID, { media: { microphone: 'allow' } })
    expect(mediaPart(entry, facts, value)).toEqual({ media: { rows: [{ kind: 'microphone', label: 'Microphone', value: 'allow' }] } })
  })
})

describe('the setMedia command', () => {
  it('changes one device and keeps the other', () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { media: { camera: 'allow', microphone: 'allow' } })
    expect(setMedia({ id: ID, kind: 'camera', value: 'block' }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).media).toEqual({ camera: 'block', microphone: 'allow' })
  })

  it('resets to Ask by dropping the answer', () => {
    const { deps: value, prefs } = deps()
    prefs.update(ID, { media: { camera: 'allow', microphone: 'block' } })
    expect(setMedia({ id: ID, kind: 'microphone', value: 'ask' }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).media).toEqual({ camera: 'allow' })
  })

  it('can allow a device the person had not answered for yet', () => {
    const { deps: value, prefs } = deps()
    expect(setMedia({ id: ID, kind: 'camera', value: 'allow' }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).media).toEqual({ camera: 'allow' })
  })

  it('refuses every field that is not exactly an id of an installed extension, a device and a value', () => {
    const { deps: value, prefs, changed } = deps()
    for (const body of [
      {},
      { id: ID, kind: 'camera' },
      { id: ID, kind: 'screen', value: 'allow' },
      { id: ID, kind: 'camera', value: 'yes' },
      { id: ID, kind: 'toString', value: 'allow' },
      { id: 'b'.repeat(32), kind: 'camera', value: 'allow' },
      { id: 4, kind: 'camera', value: 'allow' },
      { id: ID, kind: ['camera'], value: 'allow' }
    ]) expect(setMedia(body, value)).toBeUndefined()
    expect(prefs.get(ID).media).toEqual({})
    expect(changed).not.toHaveBeenCalled()
  })
})
