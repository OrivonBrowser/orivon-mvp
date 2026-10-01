import { describe, expect, it } from 'vitest'
import { createWriteQuota, MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE, MAX_WRITE_OPERATIONS_PER_HOUR } from '../bookmarks-quota.js'

describe('the bookmark write quota', () => {
  it('lets a burst up to the per-minute limit through and refuses the next with Chrome\'s text', () => {
    const quota = createWriteQuota(() => 0)
    for (let write = 0; write < MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE; write++) quota.take('a')
    expect(() => { quota.take('a') }).toThrow('This request exceeds the MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE quota.')
  })

  it('counts each extension on its own', () => {
    const quota = createWriteQuota(() => 0)
    for (let write = 0; write < MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE; write++) quota.take('a')
    expect(() => { quota.take('b') }).not.toThrow()
  })

  it('frees the minute after a minute and refuses past the hour limit', () => {
    let now = 0
    const quota = createWriteQuota(() => now)
    for (let write = 0; write < MAX_WRITE_OPERATIONS_PER_HOUR; write++) {
      now = write * 3500
      quota.take('a')
    }
    // 1000 writes spread over the hour never exceed 100 a minute, so the hour limit is what stops the next.
    now += 1000
    expect(() => { quota.take('a') }).toThrow('MAX_WRITE_OPERATIONS_PER_HOUR')
    now += 60 * 60 * 1000
    expect(() => { quota.take('a') }).not.toThrow()
  })

  it('counts nothing for a refused write', () => {
    let now = 0
    const quota = createWriteQuota(() => now)
    for (let write = 0; write < MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE; write++) quota.take('a')
    for (let again = 0; again < 5; again++) expect(() => { quota.take('a') }).toThrow()
    now = 61_000
    quota.take('a')
  })
})
