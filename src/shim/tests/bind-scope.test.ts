import { describe, expect, it, vi } from 'vitest'
import type { BindScope } from '../../contracts/index.js'
import { openAtScope, scopeForHost } from '../bind-scope.js'

describe('scopeForHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1', 'LocalHost', 'LOCALHOST'])('%s asks for the local scope', (host) => {
    expect(scopeForHost(host)).toBe('local')
  })

  it.each([undefined, '0.0.0.0', '::', '::0', '0000:0000:0000:0000:0000:0000:0000:0000'])('%s asks for the network scope', (host) => {
    expect(scopeForHost(host)).toBe('network')
  })

  it.each(['192.168.1.5', '10.0.0.1', 'example.com', '127.0.0.2', '127.1', '::ffff:127.0.0.1', '::ffff:0.0.0.0', '', ' 127.0.0.1', '0', '0.0.0.0 '])(
    '%j is a host the broker cannot honour',
    (host) => { expect(scopeForHost(host)).toBeUndefined() }
  )
})

function denied (): Error {
  return Object.assign(new Error('denied'), { code: 'denied' })
}

describe('openAtScope', () => {
  it('opens a local ask at local, with no second attempt when it is refused', async () => {
    const open = vi.fn<(scope: BindScope) => Promise<string>>(async () => { throw denied() })
    await expect(openAtScope(open, 'local')).rejects.toMatchObject({ code: 'denied' })
    expect(open.mock.calls).toEqual([['local']])
  })

  it('opens a network ask at network when the broker allows it', async () => {
    const open = vi.fn<(scope: BindScope) => Promise<string>>(async (scope) => scope)
    await expect(openAtScope(open, 'network')).resolves.toBe('network')
    expect(open.mock.calls).toEqual([['network']])
  })

  it('falls back to local only when network was refused as denied', async () => {
    const open = vi.fn<(scope: BindScope) => Promise<string>>(async (scope) => {
      if (scope === 'network') throw denied()
      return scope
    })
    await expect(openAtScope(open, 'network')).resolves.toBe('local')
    expect(open.mock.calls).toEqual([['network'], ['local']])
  })

  it('reports the local refusal when neither scope is granted', async () => {
    const localRefusal = Object.assign(new Error('local refused'), { code: 'denied' })
    const open = async (scope: BindScope): Promise<string> => { throw scope === 'network' ? denied() : localRefusal }
    await expect(openAtScope(open, 'network')).rejects.toBe(localRefusal)
  })

  it.each(['limit', 'failed', 'revoked', 'invalid', 'internal', 'unreachable'])('does not fall back on %s, which local would not cure', async (code) => {
    const open = vi.fn<(scope: BindScope) => Promise<string>>(async () => { throw Object.assign(new Error(code), { code }) })
    await expect(openAtScope(open, 'network')).rejects.toMatchObject({ code })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not fall back on an error that is not an object with a code', async () => {
    const open = vi.fn<(scope: BindScope) => Promise<string>>(async () => { throw 'denied' })
    await expect(openAtScope(open, 'network')).rejects.toBe('denied')
    expect(open).toHaveBeenCalledTimes(1)
  })
})
