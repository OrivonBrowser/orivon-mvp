import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { holdNavigation, refuseHeldNavigation } from '../navigation-hold.js'
import { loadServedAddresses } from '../served-address.js'

function tab (internal = false): { wc: EventEmitter & { loadURL: ReturnType<typeof vi.fn> }, go: (url: string) => { prevented: boolean } } {
  const wc = Object.assign(new EventEmitter(), { loadURL: vi.fn(async () => {}) })
  // The order tab-view wires them in: the hold first.
  refuseHeldNavigation(wc as never)
  loadServedAddresses(wc as never, () => internal)
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
