import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { holdNavigation, refuseHeldNavigation } from '../navigation-hold.js'
import { loadServedAddresses } from '../served-address.js'

function tab (internal = false, gateway?: Parameters<typeof loadServedAddresses>[2]): { wc: EventEmitter & { loadURL: ReturnType<typeof vi.fn> }, go: (url: string) => { prevented: boolean } } {
  const wc = Object.assign(new EventEmitter(), { loadURL: vi.fn(async () => {}) })
  // The order tab-view wires them in: the hold first.
  refuseHeldNavigation(wc as never)
  loadServedAddresses(wc as never, () => internal, gateway)
  return {
    wc,
    go: (url) => {
      const event = {
        url,
        defaultPrevented: false,
        preventDefault () { this.defaultPrevented = true }
      }
      vi.spyOn(console, 'log').mockImplementation(() => {})
      wc.emit('will-navigate', event)
      return { prevented: event.defaultPrevented }
    }
  }
}

describe('loadServedAddresses', () => {
  it('loads an ipfs: link at the URL its protocol serves it at', () => {
    const { wc, go } = tab()
    expect(go('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/').prevented).toBe(true)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
  })

  it('does not load an ipfs: link while a question about the page is open', () => {
    const { wc, go } = tab()
    const release = holdNavigation(wc)
    // Still prevented, so the scheme never reaches the OS.
    expect(go('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/').prevented).toBe(true)
    expect(wc.loadURL).not.toHaveBeenCalled()
    release()
  })

  it('leaves an internal page and an ordinary address alone', () => {
    expect(tab(true).go('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/').prevented).toBe(false)
    const ordinary = tab()
    expect(ordinary.go('https://example.com/').prevented).toBe(false)
    expect(ordinary.wc.loadURL).not.toHaveBeenCalled()
  })
})

describe('loadServedAddresses with a gateway', () => {
  const target = (url: string): string | undefined => (url.startsWith('https://site.eth.limo/') ? url.replace('site.eth.limo', 'site.eth') : undefined)

  it('hands a gateway link to open as the .eth address, instead of loading the gateway', () => {
    const open = vi.fn()
    const { wc, go } = tab(false, { target, open })
    expect(go('https://site.eth.limo/page?q=1#f').prevented).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith('https://site.eth/page?q=1#f')
    expect(wc.loadURL).not.toHaveBeenCalled()
  })

  it('keeps the link prevented but opens nothing while a question about the page is open', () => {
    const open = vi.fn()
    const { wc, go } = tab(false, { target, open })
    const release = holdNavigation(wc)
    expect(go('https://site.eth.limo/').prevented).toBe(true)
    expect(open).not.toHaveBeenCalled()
    release()
  })

  it('leaves an address with no target, and an internal page, alone', () => {
    const open = vi.fn()
    expect(tab(false, { target, open }).go('https://example.com/').prevented).toBe(false)
    expect(tab(true, { target, open }).go('https://site.eth.limo/').prevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('still loads an ipfs: link at its served address', () => {
    const open = vi.fn()
    const { wc, go } = tab(false, { target, open })
    go('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/')
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})
