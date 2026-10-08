import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { createHidSiteAsker } from '../hid-site-asker.js'

const APP = 'https://wallet.example'
const tab = {} as WebContents

function setup (allowed: (origin: string) => boolean, options: { isTab?: boolean, tabUrl?: string } = {}) {
  const asker = createHidSiteAsker({
    isTab: () => options.isTab ?? true,
    urlOf: () => options.tabUrl ?? `${APP}/index.html`,
    mayUse: allowed
  })
  return (permission: string, origin = APP, details: object = { isMainFrame: true }, contents: WebContents | null = tab) => asker.check?.(contents, permission, origin, details)
}

describe('createHidSiteAsker', () => {
  it('answers the hid check from the gate, for the tab\'s own origin', () => {
    expect(setup(() => true)('hid')).toBe(true)
    expect(setup(() => false)('hid')).toBe(false)
    expect(setup((origin) => origin === APP)('hid', `${APP}/`)).toBe(true)
  })

  it('leaves every other permission to the askers and rules behind it', () => {
    expect(setup(() => true)('media')).toBeUndefined()
    expect(setup(() => true)('serial')).toBeUndefined()
    expect(setup(() => true)('usb')).toBeUndefined()
  })

  it('refuses a frame inside the page, a page that is not a tab, and a request for another origin than the tab\'s', () => {
    expect(setup(() => true)('hid', APP, { isMainFrame: false })).toBe(false)
    expect(setup(() => true)('hid', APP, { isMainFrame: true }, null)).toBe(false)
    expect(setup(() => true, { isTab: false })('hid')).toBe(false)
    expect(setup(() => true)('hid', 'https://evil.example')).toBe(false)
    expect(setup(() => true, { tabUrl: 'about:blank' })('hid')).toBe(false)
  })

  it('has no say in a permission request, because WebHID asks through the device handler', () => {
    const asker = createHidSiteAsker({ isTab: () => true, urlOf: () => APP, mayUse: () => true })
    expect(asker.request).toBeUndefined()
  })
})
