// A utility process forked on a pinned endpoint's session raises the endpoint's 407 in main, where the secret is held. The
// arguments are the ones the probe measured in Electron 44: an event, the request's details, the challenge and the callback.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { RouteChallengeSource } from '../../lookup-session.js'
import { answerUtilityChallenges } from '../utility-login.js'

const PORT = 41_000
const source: RouteChallengeSource = (info) => info.isProxy && info.host === '127.0.0.1' && info.port === PORT ? { username: 'orivon', password: 'pinned-secret' } : undefined
const info = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ isProxy: true, scheme: 'basic', host: '127.0.0.1', port: PORT, realm: 'orivon-route', ...overrides })
const details = { url: 'https://shop.example/', pid: 1, isNavigation: false }

function challenge (...args: unknown[]): ReturnType<typeof vi.fn> {
  const child = new EventEmitter()
  answerUtilityChallenges({ on: (event, listener) => child.on(event, listener) }, source)
  const callback = vi.fn()
  child.emit('login', ...args.map((arg) => arg === 'callback' ? callback : arg))
  return callback
}

describe('a challenge from a utility process', () => {
  it('is answered with the endpoint\'s credentials when it names the endpoint\'s port, from the four arguments the child raises', () => {
    const callback = challenge({}, details, info(), 'callback')
    expect(callback).toHaveBeenCalledExactlyOnceWith('orivon', 'pinned-secret')
  })

  it('is cancelled when it names any other port, host or kind of challenge', () => {
    for (const other of [info({ port: PORT + 1 }), info({ host: 'proxy.example' }), info({ isProxy: false })]) {
      const callback = challenge({}, details, other, 'callback')
      expect(callback).toHaveBeenCalledExactlyOnceWith()
    }
  })

  it('is cancelled, not answered, when the arguments are not the four it expects', () => {
    expect(challenge(details, info(), 'callback')).toHaveBeenCalledExactlyOnceWith()
    expect(challenge({}, details, 'callback')).toHaveBeenCalledExactlyOnceWith()
    expect(challenge({}, details, { isProxy: 'yes' }, 'callback')).toHaveBeenCalledExactlyOnceWith()
    expect(challenge({}, details, null, 'callback')).toHaveBeenCalledExactlyOnceWith()
  })

  it('does nothing when no callback comes with it', () => {
    expect(() => challenge({}, details, info())).not.toThrow()
  })

  it('never hands the credentials to anything but the callback', () => {
    const child = new EventEmitter()
    const seen: unknown[] = []
    answerUtilityChallenges({ on: (event, listener) => child.on(event, listener) }, (asked) => { seen.push(asked); return source(asked) })
    const callback = vi.fn()
    const args: unknown[] = [{}, details, info(), callback]
    child.emit('login', ...args)
    expect(JSON.stringify(args.slice(0, 3))).not.toContain('pinned-secret')
    expect(seen).toHaveLength(1)
  })
})
