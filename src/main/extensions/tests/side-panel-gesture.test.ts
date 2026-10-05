import { describe, expect, it } from 'vitest'
import { createGestureLedger, GESTURE_WINDOW_MS } from '../side-panel-gesture.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function make () {
  let now = 1_000_000
  const ledger = createGestureLedger(() => now)
  return { ledger, advance: (ms: number) => { now += ms } }
}

describe('the gesture ledger', () => {
  it('is empty until the browser saw input', () => {
    expect(make().ledger.available(ID)).toBe(false)
  })

  it('counts input for five seconds and not after', () => {
    expect(GESTURE_WINDOW_MS).toBe(5000)
    const { ledger, advance } = make()
    ledger.record(ID)
    advance(4999)
    expect(ledger.available(ID)).toBe(true)
    advance(2)
    expect(ledger.available(ID)).toBe(false)
  })

  it('belongs to the extension the input was made on', () => {
    const { ledger } = make()
    ledger.record(ID)
    expect(ledger.available(OTHER)).toBe(false)
  })

  it('is used up by one spend', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.spend(ID)
    expect(ledger.available(ID)).toBe(false)
  })

  it('is cleared when the extension unloads', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.clear(ID)
    expect(ledger.available(ID)).toBe(false)
  })

  it('takes new input after a spend', () => {
    const { ledger } = make()
    ledger.record(ID)
    ledger.spend(ID)
    ledger.record(ID)
    expect(ledger.available(ID)).toBe(true)
  })
})
