import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { loadingScreenOverlay } from '../loading-screen-overlay.js'

const slotClosed = vi.hoisted(() => vi.fn())
vi.mock('../../overlays/tab-slots.js', () => ({ slotClosed }))

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function rig (): { handler: ReturnType<typeof loadingScreenOverlay.attach>, close: ReturnType<typeof vi.fn>, window: unknown } {
  const close = vi.fn()
  const window = {}
  return { handler: loadingScreenOverlay.attach({ window, close } as unknown as OverlayWindow), close, window }
}

describe('the loading-screen overlay', () => {
  it('is a cover over the page area that never takes focus and only a tab switch closes', () => {
    expect(loadingScreenOverlay).toMatchObject({
      name: 'loading-screen', placement: { kind: 'pane' }, surface: 'page', focus: 'never', layer: 'cover', keep: 'warm',
      closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false }
    })
  })

  it('says what the protocol says and the address as the person reads it', () => {
    const { handler, close } = rig()
    expect(handler.show?.({ url: `https://${CID}.ipfs.orivon/docs/` })).toEqual({
      title: 'Loading from IPFS',
      detail: 'Every block is checked against its content address before it is shown.',
      address: `ipfs://${CID}/docs/`,
      busy: true
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('cuts a long address', () => {
    const { handler } = rig()
    const view = handler.show?.({ url: `https://${CID}.ipfs.orivon/${'x'.repeat(1000)}` }) as { address: string }
    expect(view.address).toHaveLength(200)
  })

  it('closes and shows nothing for a payload that is not exactly one address string', () => {
    const { handler, close } = rig()
    const good = `https://${CID}.ipfs.orivon/`
    for (const payload of [undefined, null, 'str', 7, [], {}, { url: 7 }, { url: good, extra: 1 }, { url: good + 'x'.repeat(5000) }]) {
      expect(handler.show?.(payload), JSON.stringify(payload)).toBeUndefined()
    }
    expect(close).toHaveBeenCalledTimes(9)
  })

  it('says what the caller says for an address no protocol has a screen for, and whether anything is still moving', () => {
    const { handler, close } = rig()
    const url = 'https://example.com/app'
    expect(handler.show?.({ url, text: { title: 'Setting up Ledger', detail: 'Checking its files.', busy: true } })).toEqual({
      title: 'Setting up Ledger', detail: 'Checking its files.', address: url, busy: true
    })
    expect(handler.show?.({ url, text: { title: 'Ledger was not opened', detail: '', busy: false } })).toMatchObject({ busy: false })
    expect(close).not.toHaveBeenCalled()
  })

  it('closes for explicit text that is not exactly a title, a detail and a flag, or is too long', () => {
    const { handler, close } = rig()
    const url = 'https://example.com/app'
    const bad = [{ title: 1, detail: '', busy: true }, { title: 't', busy: true }, { title: 't', detail: '', busy: 'yes' }, { title: 't', detail: '', busy: true, extra: 1 }, { title: 't'.repeat(500), detail: '', busy: true }, { title: 't', detail: 'd'.repeat(2000), busy: true }, null, 'x']
    for (const text of bad) expect(handler.show?.({ url, text }), JSON.stringify(text)).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(bad.length)
  })

  it('closes and shows nothing for an address no protocol words a screen for', () => {
    const { handler, close } = rig()
    expect(handler.show?.({ url: 'https://example.com/' })).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('takes no command and tells the slot when it closes', () => {
    const { handler, window } = rig()
    expect(handler.request({ type: 'anything' })).toBeUndefined()
    handler.closed?.('tab-switch')
    expect(slotClosed).toHaveBeenCalledWith(window, 'loading-screen', 'tab-switch')
  })
})
