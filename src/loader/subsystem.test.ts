import { describe, expect, it } from 'vitest'
import { loaderSubsystem } from './subsystem.js'

// A shape test, not a behaviour test -- see subsystem.ts's header for why
// there is no behaviour to test yet.

describe('loaderSubsystem', () => {
  it('is named "loader", per src/main/subsystems.ts\'s convention', () => {
    expect(loaderSubsystem.name).toBe('loader')
  })

  it('registers no lifecycle hooks yet -- intentionally inert', () => {
    expect(loaderSubsystem.beforeReady).toBeUndefined()
    expect(loaderSubsystem.afterReady).toBeUndefined()
  })
})
