import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createSiteAsker } from '../site-asker.js'
import type { SiteAsksEngine } from '../site-asks-engine.js'

function rig () {
  const request = vi.fn((): Promise<boolean> | undefined => Promise.resolve(true))
  const check = vi.fn((): boolean | undefined => true)
  const engine = { request, check } as unknown as SiteAsksEngine<WebContents>
  return { asker: createSiteAsker(engine), request, check }
}
const contents = {} as WebContents

describe('the per-site asker', () => {
  it('turns an Electron request into kinds for the engine, with the page\'s details', async () => {
    const { asker, request } = rig()
    const details = { mediaTypes: ['video', 'audio'], isMainFrame: true, requestingUrl: 'https://a.example/' }
    expect(await asker.request?.(contents, 'media', details)).toBe(true)
    expect(request).toHaveBeenCalledWith({ kinds: ['camera', 'microphone'], sysex: false }, contents, details)
  })

  it('answers undefined, and does not call the engine, for a name it does not own', () => {
    const { asker, request, check } = rig()
    expect(asker.request?.(contents, 'fullscreen', {})).toBeUndefined()
    expect(asker.request?.(contents, 'media', { mediaTypes: [] })).toBeUndefined()
    expect(asker.check?.(contents, 'pointerLock', 'https://a.example', {})).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
  })

  it('checks by the kind and hands the engine the frame\'s details', () => {
    const { asker, check } = rig()
    expect(asker.check?.(contents, 'media', 'https://a.example', { mediaType: 'audio', isMainFrame: true })).toBe(true)
    expect(check).toHaveBeenCalledWith('microphone', contents, 'https://a.example', { mediaType: 'audio', isMainFrame: true })
    asker.check?.(null, 'geolocation', 'https://a.example', undefined)
    expect(check).toHaveBeenLastCalledWith('location', null, 'https://a.example', {})
  })

  it('passes a non-tab on to the engine, which answers undefined for it', () => {
    const { asker, request } = rig()
    request.mockReturnValue(undefined)
    expect(asker.request?.(contents, 'geolocation', {})).toBeUndefined()
  })
})
