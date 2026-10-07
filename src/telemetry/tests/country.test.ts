import { describe, expect, it } from 'vitest'
import { countryOfTimeZone, systemTimeZone } from '../country.js'

describe('countryOfTimeZone', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Europe/Rome', 'IT'],
    ['Europe/Belfast', 'GB'],
    ['Europe/London', 'GB'],
    ['US/Eastern', 'US'],
    ['EST5EDT', 'US'],
    ['America/Indiana/Knox', 'US'],
    ['Pacific/Honolulu', 'US'],
    ['America/Puerto_Rico', 'PR'],
    ['Asia/Kolkata', 'IN'],
    ['Asia/Calcutta', 'IN'],
    ['Europe/Kyiv', 'UA'],
    ['Europe/Busingen', 'DE'],
    ['Arctic/Longyearbyen', 'SJ'],
    ['Europe/Mariehamn', 'AX'],
    ['Antarctica/McMurdo', 'AQ'],
    ['Europe/Amsterdam', 'NL'],
    ['Europe/Nicosia', 'CY']
  ]

  it.each(cases)('%s is %s', (zone, country) => {
    expect(countryOfTimeZone(zone)).toBe(country)
  })

  it.each(['UTC', 'Etc/GMT+5', 'Not/AZone', ''])('%j belongs to no country', (zone) => {
    expect(countryOfTimeZone(zone)).toBe('unknown')
  })

  it('reads an absent zone as unknown', () => {
    expect(countryOfTimeZone(undefined)).toBe('unknown')
  })

  it('answers the same on a second ask', () => {
    expect(countryOfTimeZone('Europe/Rome')).toBe(countryOfTimeZone('Europe/Rome'))
    expect(countryOfTimeZone('Not/AZone')).toBe('unknown')
  })

  it('is always two capitals or unknown, for every zone the runtime knows', () => {
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      expect(countryOfTimeZone(zone)).toMatch(/^([A-Z]{2}|unknown)$/)
    }
  })
})

describe('systemTimeZone', () => {
  it('names a zone the runtime resolves to a country or to unknown', () => {
    expect(countryOfTimeZone(systemTimeZone())).toMatch(/^([A-Z]{2}|unknown)$/)
  })
})
