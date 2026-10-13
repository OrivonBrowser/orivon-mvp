import { describe, expect, it } from 'vitest'
import { canTunnel, isProfilePartition, profileOf, profileOfPartition, profilePartition, profilePartitionFor } from '../site-partition.js'

describe('the profile an entry puts a website in', () => {
  it('is the tunnel profile for an on entry, the direct profile for an off one, and none for a website with no entry', () => {
    expect(profileOf('on')).toBe('tunnel')
    expect(profileOf('off')).toBe('direct')
    expect(profileOf(undefined)).toBeUndefined()
  })
})

describe('the session of a profile', () => {
  it('is one persistent session per profile, shared by every website that has that entry', () => {
    expect(profilePartitionFor('tunnel', 'https://news.example')).toBe('persist:tunnel-profile')
    expect(profilePartitionFor('tunnel', 'https://other.example')).toBe('persist:tunnel-profile')
    expect(profilePartitionFor('direct', 'https://news.example')).toBe('persist:direct-profile')
  })

  it('is kept in memory for an origin that may not be written to disk, which a name with no persist: prefix is', () => {
    expect(profilePartitionFor('tunnel', 'http://news.example')).toBe('tunnel-profile-memory')
    expect(profilePartitionFor('direct', 'http://news.example')).toBe('direct-profile-memory')
    expect(profilePartition('tunnel', false)).toBe('tunnel-profile-memory')
  })

  it('is told apart from the other partitions by its name, and says which profile it is', () => {
    for (const name of ['persist:tunnel-profile', 'tunnel-profile-memory']) {
      expect(isProfilePartition(name), name).toBe(true)
      expect(profileOfPartition(name), name).toBe('tunnel')
    }
    for (const name of ['persist:direct-profile', 'direct-profile-memory']) expect(profileOfPartition(name), name).toBe('direct')
    for (const other of [undefined, 'persist:app-abc', 'persist:embed-abc', 'orivon-route-tab-abc', 'persist:orivon-local-files', 'persist:site-abc', 'site-abc']) expect(isProfilePartition(other), String(other)).toBe(false)
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
