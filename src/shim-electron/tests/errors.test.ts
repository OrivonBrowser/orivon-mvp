import { describe, expect, it } from 'vitest'
import { ElectronShimError, refuse } from '../errors.js'

describe('ElectronShimError', () => {
  it('carries the api name, the reason, and is a real Error subclass', () => {
    const error = refuse('app.getVersion', 'not-ready', 'call whenReady() first')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ElectronShimError)
    expect(error.name).toBe('ElectronShimError')
    expect(error.api).toBe('app.getVersion')
    expect(error.reason).toBe('not-ready')
    expect(error.message).toBe('call whenReady() first')
  })
})
