import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { AppMediaGrants, AppMediaKind } from '../../display-capture/types.js'
import { createAppMediaAsker } from '../app-media-asker.js'

const APP = 'https://app.example'

interface Setup { held?: AppMediaKind[], allow?: AppMediaKind[], tabUrl?: string, isTab?: boolean, isApp?: (origin: string) => boolean, blocked?: (origin: string, kind: AppMediaKind) => boolean }

function setup (options: Setup = {}) {
  const held = new Set<AppMediaKind>(options.held ?? [])
  const allow = new Set<AppMediaKind>(options.allow ?? [])
  const request = vi.fn(async (_tab: WebContents, _origin: string, kind: AppMediaKind) => {
    if (held.has(kind)) return true
    if (!allow.has(kind)) return false
    held.add(kind)
    return true
  })
  const grants: AppMediaGrants = { held: (_origin, kind) => held.has(kind), request }
  const tab = {} as WebContents
  const asker = createAppMediaAsker({
    isTab: () => options.isTab ?? true,
    urlOf: () => options.tabUrl ?? `${APP}/index.html`,
    isApp: options.isApp ?? ((origin) => origin === APP),
    blocked: options.blocked ?? (() => false),
    grants
  })
  const ask = (permission: string, details: object): Promise<boolean> | undefined => asker.request?.(tab, permission, { isMainFrame: true, securityOrigin: `${APP}/`, requestingUrl: `${APP}/index.html`, ...details })
  const check = (permission: string, details: object, origin = APP, contents: WebContents | null = tab): boolean | undefined =>
    asker.check?.(contents, permission, origin, { isMainFrame: true, securityOrigin: `${APP}/`, ...details })
  return { ask, check, request, grants }
}

describe('the app media asker: a request', () => {
  it('asks for the camera for a video request and the microphone for an audio request', async () => {
    const { ask, request } = setup({ allow: ['media.camera', 'media.microphone'] })
    expect(await ask('media', { mediaTypes: ['video'] })).toBe(true)
    expect(request.mock.calls.map((call) => call[2])).toEqual(['media.camera'])
    expect(await ask('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(request.mock.calls.map((call) => call[2])).toEqual(['media.camera', 'media.microphone'])
  })

  it('needs both for a request naming both, camera first, and stops at the first refusal', async () => {
    const both = setup({ allow: ['media.camera', 'media.microphone'] })
    expect(await both.ask('media', { mediaTypes: ['audio', 'video'] })).toBe(true)
    expect(both.request.mock.calls.map((call) => call[2])).toEqual(['media.microphone', 'media.camera'])

    const refused = setup({ allow: ['media.microphone'] })
    expect(await refused.ask('media', { mediaTypes: ['video', 'audio'] })).toBe(false)
    expect(refused.request.mock.calls.map((call) => call[2])).toEqual(['media.camera'])
  })

  it('is false for a kind the app does not hold and the grants refuse', async () => {
    expect(await setup().ask('media', { mediaTypes: ['video'] })).toBe(false)
  })

  it('answers undefined for a request with no device type: the display gate owns it', () => {
    const { ask, request } = setup()
    expect(ask('media', { mediaTypes: [] })).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([['an unknown type', ['video', 'screen']], ['no list at all', undefined], ['a non-list', 'video']])('answers undefined for %s', (_name, mediaTypes) => {
    expect(setup().ask('media', { mediaTypes })).toBeUndefined()
  })

  it('answers undefined for a permission that is not media', () => {
    expect(setup().ask('geolocation', {})).toBeUndefined()
  })

  it('answers undefined for a website, so the per-site asker decides', () => {
    expect(setup({ tabUrl: 'https://site.example/', isApp: () => false }).ask('media', { mediaTypes: ['video'] })).toBeUndefined()
  })

  it('answers undefined for a contents that is not an ordinary tab', () => {
    expect(setup({ isTab: false }).ask('media', { mediaTypes: ['video'] })).toBeUndefined()
  })

  it('refuses a subframe without asking', async () => {
    const { ask, request } = setup({ held: ['media.camera'] })
    expect(await ask('media', { mediaTypes: ['video'], isMainFrame: false })).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a request whose frame is not the tab\'s own origin', async () => {
    const { ask, request } = setup({ held: ['media.camera'] })
    expect(await ask('media', { mediaTypes: ['video'], securityOrigin: 'https://evil.example/' })).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('is false when the page left the app while the question was open', async () => {
    let url = `${APP}/index.html`
    const grants: AppMediaGrants = { held: () => true, request: async () => { url = 'https://elsewhere.example/'; return true } }
    const asker = createAppMediaAsker({ isTab: () => true, urlOf: () => url, isApp: (origin) => origin === APP, blocked: () => false, grants })
    expect(await asker.request?.({} as WebContents, 'media', { isMainFrame: true, securityOrigin: `${APP}/`, mediaTypes: ['video'] })).toBe(false)
  })
})

describe('the app media asker: a check', () => {
  it('answers from the held grant, per device type', () => {
    const { check } = setup({ held: ['media.camera'] })
    expect(check('media', { mediaType: 'video' })).toBe(true)
    expect(check('media', { mediaType: 'audio' })).toBe(false)
  })

  it('never asks', () => {
    const { check, request } = setup()
    check('media', { mediaType: 'video' })
    expect(request).not.toHaveBeenCalled()
  })

  it('answers undefined for a type that is not a device, so the site asker refuses it for an app', () => {
    expect(setup({ held: ['media.camera'] }).check('media', { mediaType: 'unknown' })).toBeUndefined()
  })

  it('answers undefined for a website, a non-tab and a permission that is not media', () => {
    expect(setup({ isApp: () => false }).check('media', { mediaType: 'video' })).toBeUndefined()
    expect(setup().check('media', { mediaType: 'video' }, APP, null)).toBeUndefined()
    expect(setup({ isTab: false }).check('media', { mediaType: 'video' })).toBeUndefined()
    expect(setup().check('geolocation', {})).toBeUndefined()
  })

  it('refuses a subframe, an embedded cross-origin frame and a frame of another origin', () => {
    const { check } = setup({ held: ['media.camera'] })
    expect(check('media', { mediaType: 'video', isMainFrame: false })).toBe(false)
    expect(check('media', { mediaType: 'video', embeddingOrigin: 'https://evil.example' })).toBe(false)
    expect(check('media', { mediaType: 'video', securityOrigin: 'https://evil.example/' })).toBe(false)
  })

  it('refuses when the tab shows another origin than the one the check names', () => {
    expect(setup({ held: ['media.camera'], tabUrl: 'https://other.example/' }).check('media', { mediaType: 'video' })).toBe(false)
  })
})

describe('the app media asker: the person\'s block on a registered origin that holds no grant', () => {
  const blocksCamera = (_origin: string, kind: AppMediaKind): boolean => kind === 'media.camera'

  it('refuses a request for a blocked kind before the grant is asked, and still asks for the kinds that are not blocked', async () => {
    const { ask, request } = setup({ allow: ['media.camera', 'media.microphone'], blocked: blocksCamera })
    expect(await ask('media', { mediaTypes: ['video'] })).toBe(false)
    expect(await ask('media', { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(await ask('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(request.mock.calls.map((call) => call[2])).toEqual(['media.microphone'])
  })

  it('refuses the synchronous check for a blocked kind even when a grant is held, and answers from the grant for the rest', () => {
    const { check } = setup({ held: ['media.camera', 'media.microphone'], blocked: blocksCamera })
    expect(check('media', { mediaType: 'video' })).toBe(false)
    expect(check('media', { mediaType: 'audio' })).toBe(true)
  })

  it('is asked with the origin the page runs on', async () => {
    const blocked = vi.fn(() => true)
    await setup({ blocked }).ask('media', { mediaTypes: ['video'] })
    expect(blocked).toHaveBeenCalledWith(APP, 'media.camera')
  })
})
