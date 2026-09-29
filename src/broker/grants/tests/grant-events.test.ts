import { describe, expect, it } from 'vitest'
import { createGrantsChangeEmitter } from '../grant-events.js'

describe('createGrantsChangeEmitter', () => {
  it('tells every listener which origin changed', () => {
    const emitter = createGrantsChangeEmitter()
    const seen: string[] = []
    emitter.onChange((origin) => { seen.push(origin) })
    emitter.emit('https://a.example')
    emitter.emit('https://b.example')
    expect(seen).toEqual(['https://a.example', 'https://b.example'])
  })

  it('stops telling a listener once it unsubscribes', () => {
    const emitter = createGrantsChangeEmitter()
    const seen: string[] = []
    const off = emitter.onChange((origin) => { seen.push(origin) })
    emitter.emit('https://a.example')
    off()
    emitter.emit('https://b.example')
    expect(seen).toEqual(['https://a.example'])
  })

  it('tells every listener, not just the first', () => {
    const emitter = createGrantsChangeEmitter()
    let first = 0
    let second = 0
    emitter.onChange(() => { first += 1 })
    emitter.onChange(() => { second += 1 })
    emitter.emit('https://a.example')
    expect(first).toBe(1)
    expect(second).toBe(1)
  })
})
