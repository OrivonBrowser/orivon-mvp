// web.embed's broker half (../capabilities/embed.ts), exercised through
// createBroker exactly the way web-capability.test.ts exercises orivon.web.
// ADR-0039's own security properties this file proves, unit-level:
//   - nothing answers without a live web.embed grant: no patterns, no
//     script, no attach;
//   - LIMITS.embeds caps the pages one app shows at once;
//   - setEmbedScript is bounded by LIMITS.embedScriptBytes and cleared by '';
//   - revoking the grant closes every page it authorised, through the SAME
//     handleTable.revoke cascade a socket answers to.

import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../contracts/index.js'
import { createBroker } from '../index.js'
import { patternSetFromCapabilities } from '../policy/manifest-patterns.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

const ORIGINS = ['https://example.com', 'https://other.example']

function registered (): ReturnType<typeof createBroker> {
  const broker = createBroker(baseDeps())
  broker.registerApp(APP, manifestWith({ web: { embed: { origins: ORIGINS } } }))
  return broker
}

async function granted (patterns: readonly string[] = ORIGINS): Promise<ReturnType<typeof createBroker>> {
  const broker = registered()
  await broker.grant(APP, 'web.embed', patterns)
  return broker
}

describe('patternSetFromCapabilities maps web.embed', () => {
  it('web.embed.origins is the pattern list for the web.embed kind', () => {
    const set = patternSetFromCapabilities({ web: { embed: { origins: ['*'] } } })
    expect(set['web.embed']).toEqual(['*'])
    expect(set['web.context']).toBeUndefined()
  })
})

describe('broker.embed.originsSync', () => {
  it('answers undefined for an origin with no live grant, however it is spelled', async () => {
    const broker = registered()
    expect(broker.embed.originsSync(APP)).toBeUndefined()
    expect(broker.embed.originsSync('not an origin')).toBeUndefined()
  })

  it('answers the live grant\'s own patterns, through the canonical origin', async () => {
    const broker = await granted()
    expect(broker.embed.originsSync('https://app.example:443/some/path')).toEqual(ORIGINS)
  })

  it('answers undefined again once the grant is revoked', async () => {
    const broker = await granted()
    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')
    await broker.revoke(APP, grant.id)
    expect(broker.embed.originsSync(APP)).toBeUndefined()
  })
})

describe('broker.embed.setScript / scriptSync', () => {
  it('is denied without a live grant, and no script is stored', async () => {
    const broker = registered()
    await expect(broker.embed.setScript(APP, { source: 'window.x = 1' })).rejects.toMatchObject({ code: 'denied' })
    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  it('stores the script under a live grant and reads it back through any spelling of the origin', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'window.x = 1' })
    expect(broker.embed.scriptSync('https://app.example:443/')).toBe('window.x = 1')
  })

  it('replaces an earlier script, and the empty string clears it', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'first' })
    await broker.embed.setScript(APP, { source: 'second' })
    expect(broker.embed.scriptSync(APP)).toBe('second')
    await broker.embed.setScript(APP, { source: '' })
    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  it('refuses a script past LIMITS.embedScriptBytes with limit, measured in UTF-8 bytes', async () => {
    const broker = await granted()
    // Two-byte characters: half as many of them as the byte cap already exceeds it.
    const source = 'é'.repeat(LIMITS.embedScriptBytes / 2 + 1)
    await expect(broker.embed.setScript(APP, { source })).rejects.toMatchObject({ code: 'limit' })
    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  it('answers no script once the grant is revoked, even though one was set', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'window.x = 1' })
    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')
    await broker.revoke(APP, grant.id)
    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  // `scriptSync` already answers undefined post-revoke because it
  // checks the LIVE GRANT first (above) -- that alone does not prove the
  // string itself is gone from `createEmbedCapability`'s own map. Re-
  // granting with NO further `setScript` call makes the grant live again
  // with nothing else changed: if the old string were still sitting in
  // that map, `scriptSync` would read it right back out here.
  it('the stored script itself is cleared on revoke, not just made unreachable while the grant is down', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'window.x = 1' })
    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')

    await broker.revoke(APP, grant.id)
    await broker.grant(APP, 'web.embed', ORIGINS)

    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  it('revokePersisted clears the stored script the same way revoke does', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'window.x = 1' })

    await broker.revokePersisted(APP, 'web.embed')
    await broker.grant(APP, 'web.embed', ORIGINS)

    expect(broker.embed.scriptSync(APP)).toBeUndefined()
  })

  it('revoking a DIFFERENT capability leaves an origin\'s embed script alone', async () => {
    const broker = await granted()
    await broker.embed.setScript(APP, { source: 'window.x = 1' })
    const fsGrant = await broker.grant(APP, 'fs', [])

    await broker.revoke(APP, fsGrant.id)

    expect(broker.embed.scriptSync(APP)).toBe('window.x = 1')
  })
})

describe('broker.embed.attach', () => {
  it('is denied without a live grant, and destroys the page it was handed first', () => {
    const broker = registered()
    const destroy = vi.fn()
    expect(() => broker.embed.attach(APP, destroy)).toThrow(expect.objectContaining({ code: 'denied' }))
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('release closes the registration once (the table\'s own close), and a later revoke does not reach it again', async () => {
    const broker = await granted()
    const destroy = vi.fn()
    const page = broker.embed.attach(APP, destroy)
    page.release()
    page.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(destroy).toHaveBeenCalledTimes(1)

    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')
    await broker.revoke(APP, grant.id)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('allows exactly LIMITS.embeds pages for one app and refuses the next with limit', async () => {
    const broker = await granted()
    for (let i = 0; i < LIMITS.embeds; i += 1) broker.embed.attach(APP, () => {})
    const overflow = vi.fn()
    expect(() => broker.embed.attach(APP, overflow)).toThrow(expect.objectContaining({ code: 'limit' }))
    expect(overflow).toHaveBeenCalledTimes(1)
  })

  it('a released slot can be taken again', async () => {
    const broker = await granted()
    const pages = Array.from({ length: LIMITS.embeds }, () => broker.embed.attach(APP, () => {}))
    pages[0]?.release()
    expect(() => broker.embed.attach(APP, () => {})).not.toThrow()
  })

  it('revoking the grant destroys every page it authorised', async () => {
    const broker = await granted()
    const first = vi.fn()
    const second = vi.fn()
    broker.embed.attach(APP, first)
    broker.embed.attach(APP, second)
    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')

    await broker.revoke(APP, grant.id)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('re-consenting to a narrower origin list destroys the pages the earlier grant authorised', async () => {
    const broker = await granted(ORIGINS)
    const destroy = vi.fn()
    broker.embed.attach(APP, destroy)

    await broker.grant(APP, 'web.embed', ['https://example.com'])

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(broker.embed.originsSync(APP)).toEqual(['https://example.com'])
  })
})
