import { afterEach, describe, expect, it } from 'vitest'
import { guardWorkerScripts, refusesWorkerScript, releaseWorkerScripts } from '../app-workers.js'

// The service workers an allowed app that runs where websites run may have: only ones whose script the shell served.

const APP = 'https://kept.eth'
const script = (over: Partial<Parameters<typeof refusesWorkerScript>[0]> = {}): Parameters<typeof refusesWorkerScript>[0] => ({ url: `${APP}/sw.js`, resourceType: 'script', hasPage: false, answeredByShell: false, ...over })

afterEach(() => { releaseWorkerScripts(APP); releaseWorkerScripts('https://other.eth') })

describe('a worker script of a guarded origin', () => {
  it('is refused when the shell did not answer it: the network gave it, and nothing checked it', () => {
    guardWorkerScripts(APP)
    expect(refusesWorkerScript(script())).toBe(true)
  })

  it('is let through when the shell answered it', () => {
    guardWorkerScripts(APP)
    expect(refusesWorkerScript(script({ answeredByShell: true }))).toBe(false)
  })

  it('is judged by the request\'s own origin, spelled as the URL parser spells it', () => {
    guardWorkerScripts('https://Kept.ETH:443')
    expect(refusesWorkerScript(script())).toBe(true)
    expect(refusesWorkerScript(script({ url: 'https://kept.eth:8443/sw.js' }))).toBe(false)
    expect(refusesWorkerScript(script({ url: 'https://sub.kept.eth/sw.js' }))).toBe(false)
  })

  it('is let through once the origin is released: it is a website\'s again', () => {
    guardWorkerScripts(APP)
    releaseWorkerScripts(APP)
    expect(refusesWorkerScript(script())).toBe(false)
  })
})

describe('what is not a worker script', () => {
  it('is never refused: a page\'s own script, or any other kind of request', () => {
    guardWorkerScripts(APP)
    expect(refusesWorkerScript(script({ hasPage: true }))).toBe(false)
    for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'image', 'other', 'stylesheet']) expect(refusesWorkerScript(script({ resourceType }))).toBe(false)
  })

  it('is never refused for an origin that is not guarded', () => {
    guardWorkerScripts(APP)
    expect(refusesWorkerScript(script({ url: 'https://other.eth/sw.js' }))).toBe(false)
    expect(refusesWorkerScript(script({ url: 'not an address' }))).toBe(false)
  })
})
