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

describe('regionOfTimeZone: the legacy IDs ICU still hands out, by table', () => {
  const cases: ReadonlyArray<readonly [string, 'EU' | 'US' | 'other']> = [
    ['America/Indianapolis', 'US'], ['America/Louisville', 'US'], ['America/Fort_Wayne', 'US'], ['America/Knox_IN', 'US'],
    ['US/Eastern', 'US'], ['US/Central', 'US'], ['US/Mountain', 'US'], ['US/Pacific', 'US'], ['US/Alaska', 'US'], ['US/Hawaii', 'US'],
    ['US/Arizona', 'US'], ['US/East-Indiana', 'US'], ['US/Indiana-Starke', 'US'], ['US/Michigan', 'US'], ['US/Aleutian', 'US'], ['US/Samoa', 'US'],
    ['America/Puerto_Rico', 'US'], ['America/St_Thomas', 'US'], ['America/Virgin', 'US'], ['Pacific/Guam', 'US'], ['Pacific/Saipan', 'US'], ['Pacific/Pago_Pago', 'US'], ['Pacific/Samoa', 'US'],
    ['Europe/Kiev', 'other'], ['Europe/Kyiv', 'other'], ['Europe/Chisinau', 'other'], ['Europe/Tiraspol', 'other'], ['Europe/Belgrade', 'other'], ['Europe/Sarajevo', 'other'],
    ['Europe/Skopje', 'other'], ['Europe/Podgorica', 'other'], ['Europe/Monaco', 'other'], ['Europe/Andorra', 'other'], ['Europe/San_Marino', 'other'], ['Europe/Vatican', 'other'], ['Europe/Gibraltar', 'other'], ['Europe/Istanbul', 'other'], ['Asia/Istanbul', 'other'],
    ['Atlantic/Canary', 'EU'], ['Atlantic/Madeira', 'EU'], ['Atlantic/Azores', 'EU'], ['Atlantic/Faeroe', 'other'], ['Atlantic/Faroe', 'other'], ['Europe/Busingen', 'EU'],
    ['Arctic/Longyearbyen', 'EU'], ['Atlantic/Jan_Mayen', 'EU'], ['Europe/Oslo', 'EU'], ['Europe/Vaduz', 'EU'], ['Atlantic/Reykjavik', 'EU'], ['Iceland', 'EU'],
    ['Europe/Belfast', 'EU'], ['Europe/Jersey', 'EU'], ['Europe/Guernsey', 'EU'], ['Europe/Isle_of_Man', 'EU'], ['GB', 'EU'], ['GB-Eire', 'EU'],
    ['Europe/Zurich', 'EU'], ['Europe/Nicosia', 'EU'], ['Asia/Nicosia', 'EU'], ['Asia/Famagusta', 'EU'], ['Europe/Mariehamn', 'EU'], ['Europe/Bratislava', 'EU'], ['Europe/Ljubljana', 'EU'], ['Europe/Zagreb', 'EU'],
    ['Portugal', 'EU'], ['Poland', 'EU'], ['Eire', 'EU'], ['Africa/Ceuta', 'EU'], ['Indian/Reunion', 'EU'], ['Indian/Mayotte', 'EU'], ['America/Martinique', 'EU'], ['America/Guadeloupe', 'EU'], ['America/Cayenne', 'EU'], ['America/Marigot', 'EU'], ['America/St_Barthelemy', 'EU'],
    ['Europe/Moscow', 'other'], ['Asia/Tokyo', 'other'], ['America/Toronto', 'other'], ['America/Mexico_City', 'other']
  ]
  it.each(cases)('%s is %s', (zone, region) => {
    expect(regionOfTimeZone(zone)).toBe(region)
  })
})
