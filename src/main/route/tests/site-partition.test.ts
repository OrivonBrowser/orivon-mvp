import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canTunnel, isSitePartition, sitePartitionFor } from '../site-partition.js'

const hash = (origin: string): string => createHash('sha256').update(origin, 'utf8').digest('hex')

describe('the session of a website with a tunnel state of its own', () => {
  it('is persist:site- and the sha256 of the origin, kept across restarts', () => {
    expect(sitePartitionFor('https://news.example')).toBe(`persist:site-${hash('https://news.example')}`)
  })

  it('is one session per origin: the same site spelled with another port or scheme is another session', () => {
    const names = new Set(['https://news.example', 'https://news.example:8443', 'https://www.news.example', 'https://other.example'].map(sitePartitionFor))
    expect(names.size).toBe(4)
  })

  it('is kept in memory for an origin that may not be written to disk, which a name with no persist: prefix is', () => {
    expect(sitePartitionFor('http://news.example')).toBe(`site-${hash('http://news.example')}`)
  })

  it('is told apart from the other partitions by its name', () => {
    expect(isSitePartition(sitePartitionFor('https://news.example'))).toBe(true)
    expect(isSitePartition(sitePartitionFor('http://news.example'))).toBe(true)
    for (const other of [undefined, 'persist:app-abc', 'persist:embed-abc', 'orivon-route-tab-abc', 'persist:orivon-local-files']) expect(isSitePartition(other), String(other)).toBe(false)
  })
})

describe('which origins can go through the tunnel', () => {
  it('is any web origin that is not this computer', () => {
    for (const origin of ['https://news.example', 'http://news.example:8080', 'https://vitalik.eth', 'https://abc.ipfs.orivon']) expect(canTunnel(origin), origin).toBe(true)
  })

  it('is not this computer, a non-canonical origin or an address with no origin', () => {
    for (const origin of ['http://localhost:3000', 'https://app.localhost', 'http://127.0.0.1:8080', 'http://[::1]/', 'https://news.example/path', 'orivon://settings', 'about:blank', '']) expect(canTunnel(origin), origin).toBe(false)
  })
})
