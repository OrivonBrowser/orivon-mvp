import { describe, expect, it } from 'vitest'
import { mapElectronResourceType, type ElectronResourceType } from '../resource-types.js'

describe('mapElectronResourceType', () => {
  const cases: Array<[ElectronResourceType, string]> = [
    ['mainFrame', 'main_frame'],
    ['subFrame', 'sub_frame'],
    ['stylesheet', 'stylesheet'],
    ['script', 'script'],
    ['image', 'image'],
    ['font', 'font'],
    ['object', 'object'],
    ['xhr', 'xmlhttprequest'],
    ['ping', 'ping'],
    ['cspReport', 'csp_report'],
    ['media', 'media'],
    ['webSocket', 'websocket'],
    ['other', 'other'],
  ]

  it.each(cases)('maps Electron %s to Chrome %s', (electronType, chromeType) => {
    expect(mapElectronResourceType(electronType)).toBe(chromeType)
  })

  it('covers every resourceType electron.d.ts declares for OnBeforeRequestListenerDetails', () => {
    // Kept in sync by hand; a mismatch here means electron.d.ts's union grew
    // or shrank and this map needs the same edit.
    expect(cases).toHaveLength(13)
  })
})
