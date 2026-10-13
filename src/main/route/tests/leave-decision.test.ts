import { describe, expect, it } from 'vitest'
import { leavesRoute } from '../leave-decision.js'
import type { LeaveWorld } from '../leave-decision.js'

const APP = 'https://routed.example'
const OTHER_APP = 'https://other.example'
const APP_PARTITION = 'persist:app-routed'

function world (overrides: Partial<LeaveWorld> = {}): LeaveWorld {
  return {
    isRouted: (origin) => origin === APP,
    isInstalledApp: (origin) => origin === APP || origin === OTHER_APP,
    routedOriginOf: (partition) => partition === APP_PARTITION ? APP : undefined,
    servedOrigin: (url) => url.startsWith('ipfs://') ? url.replace(/^(ipfs:\/\/[^/]+).*$/u, '$1') : url.startsWith('https://ipfs.orivon/') ? `ipfs://${url.split('/')[3] ?? ''}` : undefined,
    ...overrides
  }
}

describe('a routed app\'s page opening an address', () => {
  it('asks about a website, naming its origin', () => {
    expect(leavesRoute(`${APP}/page`, 'https://news.example/a?b=1', world())).toEqual({ kind: 'website', origin: 'https://news.example', app: APP })
  })

  it('asks about a plain http website too', () => {
    expect(leavesRoute(`${APP}/`, 'http://news.example:8080/', world())).toEqual({ kind: 'website', origin: 'http://news.example:8080', app: APP })
  })

  it('never asks about its own origin', () => {
    expect(leavesRoute(`${APP}/a`, `${APP}/b#c`, world())).toBeUndefined()
  })

  it('never asks about another installed app whose route is on: it opens in its own routed session', () => {
    const both = world({ isRouted: () => true })
    expect(leavesRoute(`${APP}/`, `${OTHER_APP}/x`, both)).toBeUndefined()
  })

  it('asks about another installed app whose route is off, as an app', () => {
    expect(leavesRoute(`${APP}/`, `${OTHER_APP}/x`, world())).toEqual({ kind: 'app', origin: OTHER_APP, app: APP })
  })

  it('never asks when the page that starts it is not a routed app\'s', () => {
    expect(leavesRoute('https://news.example/', 'https://other-site.example/', world())).toBeUndefined()
    expect(leavesRoute(`${OTHER_APP}/`, 'https://news.example/', world())).toBeUndefined()
  })

  it('never asks about an address with no web origin', () => {
    for (const target of ['about:blank', 'blob:https://routed.example/1', 'data:text/html,hi', 'javascript:1', 'file:///etc/hosts', 'orivon://settings/', 'mailto:a@b.example', 'not a url', '']) {
      expect(leavesRoute(`${APP}/`, target, world()), target).toBeUndefined()
    }
  })

  it('asks about an address Orivon serves itself as one that no proxy can carry, naming it as a person reads it', () => {
    expect(leavesRoute(`${APP}/`, 'ipfs://bafyexample/page', world())).toEqual({ kind: 'served', origin: 'ipfs://bafyexample', app: APP })
    expect(leavesRoute(`${APP}/`, 'https://ipfs.orivon/bafyexample/page', world())).toEqual({ kind: 'served', origin: 'ipfs://bafyexample', app: APP })
    expect(leavesRoute('about:blank', 'ipfs://bafyexample', world(), APP_PARTITION)).toMatchObject({ kind: 'served', app: APP })
  })

  it('does not ask about a served address when the page is not a routed app\'s, or when it is an installed app', () => {
    expect(leavesRoute('https://news.example/', 'ipfs://bafyexample', world())).toBeUndefined()
    const installed = world({ isInstalledApp: () => true, servedOrigin: () => 'ipfs://other' })
    expect(leavesRoute(`${APP}/`, 'https://other.example/', installed)).toEqual({ kind: 'app', origin: OTHER_APP, app: APP })
  })

  it('asks about this computer too: a page there is in the shared session, where whatever it opens is direct', () => {
    for (const target of ['http://127.0.0.1:8080/', 'http://localhost:3000/', 'http://[::1]:9/']) {
      expect(leavesRoute(`${APP}/`, target, world()), target).toMatchObject({ kind: 'website' })
    }
  })

  it('still runs as the app when its document has no web address of its own: a blob it made, or a blank page in its session', () => {
    expect(leavesRoute(`blob:${APP}/1234`, 'https://news.example/', world())).toMatchObject({ kind: 'website', app: APP })
    expect(leavesRoute('about:blank', 'https://news.example/', world(), APP_PARTITION)).toMatchObject({ kind: 'website', app: APP })
    expect(leavesRoute('data:text/html,hi', 'https://news.example/', world(), APP_PARTITION)).toMatchObject({ kind: 'website', app: APP })
  })

  it('does not take a blob of another origin, or a blank page in another session, for the app\'s', () => {
    expect(leavesRoute('blob:https://news.example/1234', 'https://other-site.example/', world())).toBeUndefined()
    expect(leavesRoute('about:blank', 'https://news.example/', world(), 'persist:app-other')).toBeUndefined()
    expect(leavesRoute('about:blank', 'https://news.example/', world(), undefined)).toBeUndefined()
  })

  it('reads a page with no address and no app session as not a routed app\'s', () => {
    expect(leavesRoute('', 'https://news.example/', world())).toBeUndefined()
    expect(leavesRoute('about:blank', 'https://news.example/', world())).toBeUndefined()
  })

  it('treats the same host on another port or scheme as another origin', () => {
    expect(leavesRoute(`${APP}/`, 'http://routed.example/', world())).toMatchObject({ kind: 'website' })
    expect(leavesRoute(`${APP}/`, 'https://routed.example:8443/', world())).toMatchObject({ kind: 'website' })
  })
})

describe('a page of a website with its tunnel on opening an address', () => {
  const SITE = 'https://news.example'
  const siteWorld = (overrides: Partial<LeaveWorld> = {}): LeaveWorld => world({ isRouted: (origin) => origin === SITE, ...overrides })

  it('asks about another website, as the site asking', () => {
    expect(leavesRoute(`${SITE}/`, 'https://elsewhere.example/', siteWorld())).toEqual({ kind: 'website', origin: 'https://elsewhere.example', app: SITE, site: true })
  })

  it('asks about an installed app whose route is off, and about an address Orivon serves itself', () => {
    expect(leavesRoute(`${SITE}/`, `${OTHER_APP}/`, siteWorld())).toEqual({ kind: 'app', origin: OTHER_APP, app: SITE, site: true })
    expect(leavesRoute(`${SITE}/`, 'ipfs://abc/x', siteWorld())).toEqual({ kind: 'served', origin: 'ipfs://abc', app: SITE, site: true })
  })

  it('asks nothing about another website whose tunnel is on: it opens in a session of its own', () => {
    expect(leavesRoute(`${SITE}/`, 'https://elsewhere.example/', siteWorld({ isRouted: () => true }))).toBeUndefined()
  })

  it('asks nothing about its own origin, and nothing for a document with no web address in its session', () => {
    expect(leavesRoute(`${SITE}/a`, `${SITE}/b`, siteWorld())).toBeUndefined()
    expect(leavesRoute('about:blank', 'https://elsewhere.example/', siteWorld({ routedOriginOf: () => SITE }), 'persist:site-x')).toEqual({ kind: 'website', origin: 'https://elsewhere.example', app: SITE, site: true })
  })

  it('does not mark a routed installed app as a site', () => {
    expect(leavesRoute(`${APP}/`, 'https://news.example/', world())).toEqual({ kind: 'website', origin: 'https://news.example', app: APP })
  })
})
