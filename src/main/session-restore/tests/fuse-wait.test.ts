import { beforeEach, describe, expect, it, vi } from 'vitest'

const fuse = vi.hoisted(() => ({ known: undefined as string | undefined, read: vi.fn() }))
vi.mock('../../local-files/file-fuse.js', () => ({ knownFileProtocolFuse: () => fuse.known, fileProtocolFuse: fuse.read }))

import { holdsLocalFile, deferUntilFuseKnown } from '../fuse-wait.js'

beforeEach(() => { fuse.known = undefined; fuse.read.mockReset() })

describe('holdsLocalFile', () => {
  it('is true when one tab is a local file', () => {
    expect(holdsLocalFile([{ url: 'https://a.example/' }, { url: 'file:///home/a/x.html' }])).toBe(true)
  })
  it('is false for web addresses and for nothing', () => {
    expect(holdsLocalFile([{ url: 'https://a.example/' }])).toBe(false)
    expect(holdsLocalFile([])).toBe(false)
  })
})

describe('deferUntilFuseKnown', () => {
  it('does nothing when nothing needs the fuse, and does not read it', () => {
    const later = vi.fn()
    expect(deferUntilFuseKnown(false, later)).toBe(false)
    expect(later).not.toHaveBeenCalled()
    expect(fuse.read).not.toHaveBeenCalled()
  })

  it('does nothing when the fuse has been read', () => {
    fuse.known = 'off'
    const later = vi.fn()
    expect(deferUntilFuseKnown(true, later)).toBe(false)
    expect(later).not.toHaveBeenCalled()
  })

  it('calls back once the read finishes when the fuse is unknown', async () => {
    let finish: (state: string) => void = () => undefined
    fuse.read.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const later = vi.fn()
    expect(deferUntilFuseKnown(true, later)).toBe(true)
    expect(later).not.toHaveBeenCalled()
    finish('off')
    await vi.waitFor(() => { expect(later).toHaveBeenCalledOnce() })
  })
})
