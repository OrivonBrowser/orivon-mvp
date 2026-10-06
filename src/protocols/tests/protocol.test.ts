import { describe, expect, it } from 'vitest'
import type { NameResolver } from '../resolution/providers.js'
import { defineProtocol, describeProtocol, namespacesOf } from '../protocol.js'
import { BUILTIN_PROTOCOLS } from '../builtin.js'

const noop: NameResolver['resolve'] = async () => []

describe('describeProtocol', () => {
  it('accepts a scheme protocol and a top-level-domain protocol, and freezes what it returns', () => {
    const ipfs = describeProtocol({ id: 'ipfs', schemes: ['ipfs', 'ipns'], topLevelDomains: [] })
    expect(namespacesOf(ipfs)).toEqual(['ipfs:', 'ipns:'])
    expect(namespacesOf(describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'] }))).toEqual(['.eth'])
    expect(Object.isFrozen(ipfs) && Object.isFrozen(ipfs.schemes)).toBe(true)
  })

  it.each([
    [{ id: 'Bad', schemes: ['x'], topLevelDomains: [] }, /lowercase/],
    [{ id: 'p', schemes: ['IPFS'], topLevelDomains: [] }, /lowercase/],
    [{ id: 'p', schemes: ['ip-fs'], topLevelDomains: [] }, /lowercase/],
    [{ id: 'p', schemes: ['https'], topLevelDomains: [] }, /reserved/],
    [{ id: 'p', schemes: ['javascript'], topLevelDomains: [] }, /reserved/],
    [{ id: 'p', schemes: ['orivon-app'], topLevelDomains: [] }, /lowercase/],
    [{ id: 'p', schemes: ['orivonx'], topLevelDomains: [] }, /reserved/],
    [{ id: 'p', schemes: [], topLevelDomains: ['localhost'] }, /reserved/],
    [{ id: 'p', schemes: [], topLevelDomains: ['orivon'] }, /reserved/],
    [{ id: 'p', schemes: [], topLevelDomains: ['-eth'] }, /not a top-level domain/],
    [{ id: 'p', schemes: [], topLevelDomains: [] }, /serves no scheme/],
    [{ id: 'p', schemes: ['a', 'a'], topLevelDomains: [] }, /twice/],
    [{ id: 'p', schemes: ['ipfs'], topLevelDomains: [], displayScheme: 'ipfs' }, /displayScheme needs a top-level domain/],
    [{ id: 'p', schemes: [], topLevelDomains: ['eth'], displayScheme: 'IPFS' }, /lowercase/],
    [{ id: 'p', schemes: [], topLevelDomains: ['eth'], displayScheme: 'https' }, /reserved/]
  ])('refuses %o', (descriptor, message) => {
    expect(() => describeProtocol(descriptor)).toThrow(message)
  })

  it('accepts a displayScheme only alongside a top-level domain, and keeps it out of the frozen result otherwise', () => {
    const ens = describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'], displayScheme: 'ipfs' })
    expect(ens.displayScheme).toBe('ipfs')
    const ipfs = describeProtocol({ id: 'ipfs', schemes: ['ipfs'], topLevelDomains: [] })
    expect('displayScheme' in ipfs).toBe(false)
  })

  it('accepts a loading screen, trims it, freezes it and keeps an absent detail absent', () => {
    const base = { id: 'ipfs', schemes: ['ipfs'], topLevelDomains: [] }
    const full = describeProtocol({ ...base, loadingScreen: { title: '  Loading from IPFS ', detail: ' Checked. ' } })
    expect(full.loadingScreen).toEqual({ title: 'Loading from IPFS', detail: 'Checked.' })
    expect(Object.isFrozen(full.loadingScreen)).toBe(true)
    const bare = describeProtocol({ ...base, loadingScreen: { title: 'Loading' } })
    expect(bare.loadingScreen).toEqual({ title: 'Loading' })
    expect('detail' in (bare.loadingScreen ?? {})).toBe(false)
    expect('loadingScreen' in describeProtocol(base)).toBe(false)
  })

  it.each([
    [{ title: '' }, /loadingScreen title/],
    [{ title: '   ' }, /loadingScreen title/],
    [{ title: 'x'.repeat(49) }, /loadingScreen title/],
    [{ title: 'a\nb' }, /loadingScreen title/],
    [{ title: 'a\u007fb' }, /loadingScreen title/],
    [{ title: 'ok', detail: '' }, /loadingScreen detail/],
    [{ title: 'ok', detail: 'x'.repeat(141) }, /loadingScreen detail/],
    [{ title: 'ok', detail: 'a\tb' }, /loadingScreen detail/]
  ])('refuses the loading screen %o', (loadingScreen, message) => {
    expect(() => describeProtocol({ id: 'p', schemes: ['p'], topLevelDomains: [], loadingScreen })).toThrow(message)
  })

  it('takes a title of 48 characters and a detail of 140', () => {
    const screen = describeProtocol({ id: 'p', schemes: ['p'], topLevelDomains: [], loadingScreen: { title: 'x'.repeat(48), detail: 'y'.repeat(140) } }).loadingScreen
    expect(screen?.title).toHaveLength(48)
    expect(screen?.detail).toHaveLength(140)
  })

  it('holds for every built-in protocol, whose namespaces never overlap', () => {
    const namespaces = BUILTIN_PROTOCOLS.flatMap((p) => namespacesOf(describeProtocol(p)))
    expect(new Set(namespaces).size).toBe(namespaces.length)
  })
})

describe('defineProtocol', () => {
  it('registers resolvers and gatherers under the descriptor', () => {
    const resolver: NameResolver = { id: 'r', namespaces: ['ipfs:'], resolve: noop }
    const protocol = defineProtocol({ id: 'ipfs', schemes: ['ipfs'], topLevelDomains: [] }, { resolvers: [resolver] })
    expect(protocol.resolvers).toEqual([resolver])
    expect(protocol.gatherers).toEqual([])
  })

  it('refuses a resolver answering a namespace the descriptor does not declare, since the shell would never route it', () => {
    const stray: NameResolver = { id: 'stray', namespaces: ['.sol'], resolve: noop }
    expect(() => defineProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'] }, { resolvers: [stray] })).toThrow(/answers \.sol/)
  })
})
