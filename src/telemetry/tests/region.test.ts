import { describe, expect, it } from 'vitest'
import { regionOfTimeZone } from '../region.js'

describe('regionOfTimeZone', () => {
  it('reads EU, EEA, UK and Swiss zones as EU', () => {
    for (const zone of ['Europe/Rome', 'Europe/Berlin', 'Europe/London', 'Europe/Zurich', 'Europe/Oslo', 'Atlantic/Reykjavik', 'Atlantic/Madeira', 'Europe/Dublin']) {
      expect(regionOfTimeZone(zone)).toBe('EU')
    }
  })

  it('reads United States zones as US, including the sub-zoned states', () => {
    for (const zone of ['America/New_York', 'America/Los_Angeles', 'America/Indiana/Knox', 'America/Kentucky/Louisville', 'America/North_Dakota/Center', 'Pacific/Honolulu', 'US/Eastern']) {
      expect(regionOfTimeZone(zone)).toBe('US')
    }
  })

  it('reads every other zone, a European one outside the EEA included, and a missing zone as other', () => {
    for (const zone of ['Asia/Tokyo', 'America/Sao_Paulo', 'Europe/Moscow', 'Europe/Istanbul', 'UTC', '', 'not a zone']) {
      expect(regionOfTimeZone(zone)).toBe('other')
    }
    expect(regionOfTimeZone(undefined)).toBe('other')
  })
})
