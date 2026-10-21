import { describe, expect, it } from 'vitest'
import { parseSeamNotes, runningRelease } from '../running-release.js'

describe('the release this process runs', () => {
  it('is the app version with no notes when the build carries none (a run of the unit tests has no build)', () => {
    expect(runningRelease('0.0.0')).toEqual({ version: '0.0.0', notes: null })
  })

  it('ignores the test variable outside a test build', () => {
    const env = { ORIVON_TEST_RELEASE_NOTES: JSON.stringify({ version: '9.9.9', sections: [{ heading: 'Added', items: ['x'] }] }) }
    expect(runningRelease('0.0.0', env).version).toBe('0.0.0')
  })
})

describe('the notes a test names', () => {
  it('reads the version and its sections', () => {
    const notes = { version: '1.2.3', sections: [{ heading: 'Added', items: ['**A**: b'] }] }
    expect(parseSeamNotes(JSON.stringify(notes))).toEqual(notes)
  })

  it.each([undefined, '', 'not json', '"x"', 'null', '{}', '{"version":"1","sections":[{"heading":3,"items":[]}]}', '{"version":"1","sections":[{"heading":"A","items":[1]}]}'])('refuses %s', (raw) => {
    expect(parseSeamNotes(raw)).toBeUndefined()
  })
})
