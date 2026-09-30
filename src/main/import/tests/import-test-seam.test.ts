import { describe, expect, it } from 'vitest'
import { importLocation } from '../import-test-seam.js'

describe('importLocation', () => {
  it('ignores ORIVON_TEST_IMPORT_HOME outside a test build, so the variable cannot move the detector off the real home', () => {
    const real = { platform: 'linux' as const, home: '/home/real', env: { XDG_CONFIG_HOME: '/x' } }
    expect(importLocation(real, { ORIVON_TEST_IMPORT_HOME: '/tmp/fake' })).toBe(real)
    expect(importLocation(real, {})).toBe(real)
  })
})
