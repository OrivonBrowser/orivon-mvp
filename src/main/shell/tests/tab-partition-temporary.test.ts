import { describe, expect, it } from 'vitest'
import { partitionChanged, partitionChangedByPage } from '../tab-partition.js'

const TEMPORARY = 'orivon-route-tab-0123456789abcdef01'

describe('partitionChangedByPage', () => {
  it('keeps a page of a temporary routed session in it on the open web, where the shared session would be direct', () => {
    expect(partitionChanged('https://other.example/', TEMPORARY)).toEqual({ to: undefined })
    expect(partitionChangedByPage('https://other.example/', TEMPORARY)).toBeUndefined()
  })

  it('answers as partitionChanged for a tab in any other session', () => {
    expect(partitionChangedByPage('https://other.example/', 'persist:app-1')).toEqual({ to: undefined })
    expect(partitionChangedByPage('https://other.example/', undefined)).toBeUndefined()
  })

  it('has no swap for an address with no origin', () => {
    expect(partitionChangedByPage('about:blank', TEMPORARY)).toBeUndefined()
  })
})
