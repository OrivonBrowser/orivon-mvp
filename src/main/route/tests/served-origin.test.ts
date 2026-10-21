import { describe, expect, it } from 'vitest'
import { servedOrigin } from '../served-origin.js'

describe('the address Orivon serves itself', () => {
  it('reads a protocol address as a person typed it', () => {
    expect(servedOrigin('ipfs://bafyexample/page?x=1')).toBe('ipfs://bafyexample')
    expect(servedOrigin('IPFS://bafyexample')).toBe('ipfs://bafyexample')
    expect(servedOrigin('ipns://some-name.example/a')).toBe('ipns://some-name.example')
    expect(servedOrigin('bzz://vitalik.eth/')).toBe('https://vitalik.eth')
  })

  it('knows the url it is served at and a name under a top-level domain a protocol serves', () => {
    expect(servedOrigin('https://ipfs.orivon/bafyexample/page')).toBe('ipfs://bafyexample')
    expect(servedOrigin('https://vitalik.eth/')).toBe('https://vitalik.eth')
    expect(servedOrigin('http://vitalik.eth/')).toBe('http://vitalik.eth')
  })

  it('is undefined for every other address', () => {
    for (const url of ['https://news.example/', 'http://127.0.0.1:8080/', 'about:blank', 'data:text/html,hi', 'javascript:1', 'orivon://settings/', 'mailto:a@b.example', 'not a url', '', 'file:///etc/hosts', 'blob:https://routed.example/1']) {
      expect(servedOrigin(url), url).toBeUndefined()
    }
  })
})
