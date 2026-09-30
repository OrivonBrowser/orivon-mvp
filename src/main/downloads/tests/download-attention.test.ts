import { describe, expect, it } from 'vitest'
import { DownloadAttention } from '../download-attention.js'
import type { DownloadEntry, DownloadState } from '../download-types.js'

const entry = (id: string, state: DownloadState): DownloadEntry => ({
  id, url: 'https://a.example/f', referrer: '', fileName: id, savePath: '', mime: '', total: 10, received: 0, state, startedAt: 1, danger: false
})

function tracker (initial: DownloadEntry[] = []) {
  let list = initial
  const attention = new DownloadAttention(() => list)
  return { attention, setList: (next: DownloadEntry[]) => { list = next } }
}

describe('DownloadAttention', () => {
  it('has nothing to say about what was already in the list', () => {
    expect(tracker([entry('a', 'completed'), entry('b', 'interrupted')]).attention.value()).toBe('none')
  })

  it('says a download arrived when a running one completes, until it is seen', () => {
    const { attention } = tracker([entry('a', 'progressing')])
    attention.note(entry('a', 'completed'))
    expect(attention.value()).toBe('done')
    attention.seen()
    expect(attention.value()).toBe('none')
  })

  it('says a download failed when a running one is interrupted, and stops when it runs again', () => {
    const { attention } = tracker([entry('a', 'progressing')])
    attention.note(entry('a', 'interrupted'))
    expect(attention.value()).toBe('failed')
    attention.note(entry('a', 'progressing'))
    expect(attention.value()).toBe('none')
  })

  it('does not count a download the person cancelled', () => {
    const { attention } = tracker([entry('a', 'progressing')])
    attention.note(entry('a', 'cancelled'))
    expect(attention.value()).toBe('none')
  })

  it('ranks a file waiting for an answer over a failure, and a failure over an arrival', () => {
    const { attention } = tracker([entry('a', 'progressing'), entry('b', 'progressing'), entry('c', 'progressing')])
    attention.note(entry('a', 'completed'))
    expect(attention.value()).toBe('done')
    attention.note(entry('b', 'interrupted'))
    expect(attention.value()).toBe('failed')
    attention.note(entry('c', 'held'))
    expect(attention.value()).toBe('warn')
  })

  it('keeps warning after seen() while a file is still held, and lets go once it is answered', () => {
    const { attention } = tracker([entry('c', 'progressing')])
    attention.note(entry('c', 'held'))
    attention.seen()
    expect(attention.value()).toBe('warn')
    attention.note(entry('c', 'completed'))
    expect(attention.value()).toBe('none')
  })

  it('reads the list again when it changed in a way that names no download, and forgets what left it', () => {
    const { attention, setList } = tracker([entry('a', 'progressing')])
    attention.note(entry('a', 'completed'))
    setList([])
    attention.note(null)
    expect(attention.value()).toBe('none')
  })

  it('knows when everything running is paused', () => {
    const { attention } = tracker([entry('a', 'paused'), entry('b', 'paused'), entry('c', 'completed')])
    expect(attention.pausedOnly).toBe(true)
    attention.note(entry('b', 'progressing'))
    expect(attention.pausedOnly).toBe(false)
    expect(tracker().attention.pausedOnly).toBe(false)
  })
})
