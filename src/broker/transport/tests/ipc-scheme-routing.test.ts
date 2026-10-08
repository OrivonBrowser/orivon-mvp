// The control channel's scheme-routing calls (d-0596): the payload check, the grant that comes before the shell's
// host is reached, and that the origin the host sees is the sender frame's. What the host does is
// src/main/scheme-routing/tests/scheme-routing.test.ts's job.

import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { SchemeHost } from '../ipc-validation.js'
import { APP, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

const GRANTED = { hasGrantsSync: () => true }

function host (answers: Partial<SchemeHost> = {}): { host: SchemeHost, seen: unknown[][] } {
  const seen: unknown[][] = []
  return {
    seen,
    host: {
      nextUrl: async (...args) => { seen.push(['nextUrl', args[0], args[2] === undefined ? 'no tab' : 'a tab']); return await (answers.nextUrl?.(...args) ?? Promise.resolve('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567')) },
      requestHandler: async (origin, scheme) => { seen.push(['requestHandler', origin, scheme]); return await (answers.requestHandler?.(origin, scheme, {} as never) ?? Promise.resolve(true)) },
      isHandler: async (origin, scheme) => { seen.push(['isHandler', origin, scheme]); return await (answers.isHandler?.(origin, scheme) ?? Promise.resolve(false)) }
    }
  }
}

const ctxOf = (schemeHost: SchemeHost | undefined): { requestGrant: undefined, schemeHost: SchemeHost | undefined } => ({ requestGrant: undefined, schemeHost })

describe('app.nextOpenUrl', () => {
  it('asks the host for the next link of the sender frame\'s origin and returns it', async () => {
    const { host: schemeHost, seen } = host()
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('app.nextOpenUrl', undefined), undefined, undefined, ctxOf(schemeHost))
    expect(response).toEqual({ id: 'req-1', ok: true, result: expect.stringMatching(/^magnet:/) })
    expect(seen).toEqual([['nextUrl', APP, 'a tab']])
  })

  it('answers null when the wait ended with no link', async () => {
    const { host: schemeHost } = host({ nextUrl: async () => null })
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('app.nextOpenUrl', undefined), undefined, undefined, ctxOf(schemeHost))
    expect(response).toEqual({ id: 'req-1', ok: true, result: null })
  })

  it('refuses denied for an origin that holds no grant, and never reaches the host', async () => {
    const { host: schemeHost, seen } = host()
    const response = await handleControlRequest(stubBroker([], { hasGrantsSync: () => false }), frameFor(APP), envelope('app.nextOpenUrl', undefined), undefined, undefined, ctxOf(schemeHost))
    expect(response).toMatchObject({ ok: false, code: 'denied' })
    expect(seen).toEqual([])
  })

  it('fails internal when the shell never wired the host', async () => {
    const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('app.nextOpenUrl', undefined), undefined, undefined, ctxOf(undefined))
    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })
})

describe('app.requestSchemeHandler and app.isSchemeHandler', () => {
  it('pass the scheme with the sender frame\'s origin, never one from the payload', async () => {
    const { host: schemeHost, seen } = host({ isHandler: async () => true })
    const asked = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('app.requestSchemeHandler', { scheme: 'magnet', origin: 'https://evil.example' }), undefined, undefined, ctxOf(schemeHost))
    const checked = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope('app.isSchemeHandler', { scheme: 'magnet' }), undefined, undefined, ctxOf(schemeHost))
    expect(asked).toEqual({ id: 'req-1', ok: true, result: true })
    expect(checked).toEqual({ id: 'req-1', ok: true, result: true })
    expect(seen).toEqual([['requestHandler', APP, 'magnet'], ['isHandler', APP, 'magnet']])
  })

  it('rejects a payload that is no scheme name as invalid, before the host', async () => {
    const { host: schemeHost, seen } = host()
    for (const method of ['app.requestSchemeHandler', 'app.isSchemeHandler']) {
      for (const payload of [undefined, {}, { scheme: 7 }, { scheme: '' }, { scheme: 'Magnet' }, { scheme: '1a' }, { scheme: 'a b' }, { scheme: 'x'.repeat(65) }, null]) {
        const response = await handleControlRequest(stubBroker([], GRANTED), frameFor(APP), envelope(method, payload), undefined, undefined, ctxOf(schemeHost))
        expect(response, `${method} ${JSON.stringify(payload)}`).toMatchObject({ ok: false, code: 'invalid' })
      }
    }
    expect(seen).toEqual([])
  })

  it('refuse denied for an origin that holds no grant', async () => {
    const { host: schemeHost, seen } = host()
    for (const method of ['app.requestSchemeHandler', 'app.isSchemeHandler']) {
      const response = await handleControlRequest(stubBroker([], { hasGrantsSync: () => false }), frameFor(APP), envelope(method, { scheme: 'magnet' }), undefined, undefined, ctxOf(schemeHost))
      expect(response).toMatchObject({ ok: false, code: 'denied' })
    }
    expect(seen).toEqual([])
  })
})
