import { afterEach, describe, expect, it } from 'vitest'
import { devOnlySwitches } from '../dev-switches.js'

const ORIGINAL = process.env['ORIVON_DEV_ORIGINS']

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['ORIVON_DEV_ORIGINS']
  else process.env['ORIVON_DEV_ORIGINS'] = ORIGINAL
})

describe('devOnlySwitches', () => {
  it('is empty outside developer mode -- npm start keeps a real cache', () => {
    delete process.env['ORIVON_DEV_ORIGINS']
    expect(devOnlySwitches()).toEqual([])
  })

  it('turns off the HTTP cache in developer mode', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    expect(devOnlySwitches()).toEqual(['disable-http-cache'])
  })

  it('treats any other value the same as unset (devModeEnabled\'s own rule)', () => {
    process.env['ORIVON_DEV_ORIGINS'] = 'true'
    expect(devOnlySwitches()).toEqual([])
  })
})
