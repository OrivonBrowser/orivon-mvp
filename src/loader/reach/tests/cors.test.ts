import { describe, expect, it } from 'vitest'
import { isCorsPreflight, preflightResponse, withReachCors } from '../cors.js'

const APP = 'https://app.example'

describe('isCorsPreflight', () => {
  it('is a browser preflight only when Access-Control-Request-Method is present', () => {
    expect(isCorsPreflight(new Request('https://cdn.example/x', { method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT' } }))).toBe(true)
    expect(isCorsPreflight(new Request('https://cdn.example/x', { method: 'OPTIONS' }))).toBe(false)
    expect(isCorsPreflight(new Request('https://cdn.example/x'))).toBe(false)
  })
})

describe('preflightResponse', () => {
  it('allows the requested method and headers for the app origin, with credentials', () => {
    const request = new Request('https://cdn.example/x', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, x-api-key' }
    })
    const response = preflightResponse(request, APP)
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(APP)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-allow-methods')).toBe('PUT')
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, x-api-key')
  })
})

describe('withReachCors', () => {
  it('makes the response readable by the app origin, exposes its headers, and keeps status and body', async () => {
    const upstream = new Response('body', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'x-rate-limit': '10', 'access-control-allow-origin': '*' }
    })
    const response = withReachCors(upstream, APP)
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(await response.text()).toBe('body')
    expect(response.headers.get('access-control-allow-origin')).toBe(APP)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-expose-headers')).toBe('content-type, x-rate-limit')
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('keeps a bodiless response bodiless', () => {
    const response = withReachCors(new Response(null, { status: 302, headers: { location: '/next' } }), APP)
    expect(response.status).toBe(302)
    expect(response.body).toBeNull()
    expect(response.headers.get('location')).toBe('/next')
  })
})
