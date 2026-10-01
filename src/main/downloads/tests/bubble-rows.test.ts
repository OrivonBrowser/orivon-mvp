import { describe, expect, it } from 'vitest'
import { asBubbleRequest, bubbleRows, BUBBLE_ROWS } from '../bubble-rows.js'
import type { DownloadEntry, DownloadState } from '../download-types.js'

const entry = (id: string, state: DownloadState): DownloadEntry => ({
  id, url: 'https://a.example/f', referrer: 'https://a.example/', fileName: id, savePath: `/dl/${id}`, mime: '', total: 10, received: 0, state, startedAt: 1, danger: false
})

describe('bubbleRows', () => {
  it('puts held files first, then what is running, then the rest in the order given', () => {
    const rows = bubbleRows([entry('done1', 'completed'), entry('run1', 'progressing'), entry('done2', 'cancelled'), entry('held1', 'held'), entry('paused1', 'paused')])
    expect(rows.map((row) => row.id)).toEqual(['held1', 'run1', 'paused1', 'done1', 'done2'])
  })

  it('shows six at most', () => {
    const many = Array.from({ length: 10 }, (_, index) => entry(`f${String(index)}`, 'completed'))
    expect(bubbleRows(many)).toHaveLength(BUBBLE_ROWS)
    expect(bubbleRows(many).map((row) => row.id)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5'])
  })

  it('sends no path and no referrer', () => {
    const [row] = bubbleRows([entry('a', 'completed')])
    expect(row).toMatchObject({ savePath: '', referrer: '', fileName: 'a' })
  })

  it('is empty for an empty list', () => {
    expect(bubbleRows([])).toEqual([])
  })
})

describe('asBubbleRequest', () => {
  it('accepts every action that names a download by its id', () => {
    for (const type of ['pause', 'resume', 'cancel', 'retry', 'remove', 'open', 'showInFolder', 'keep', 'discard']) {
      expect(asBubbleRequest({ type, id: 'abc' })).toEqual({ type, id: 'abc' })
    }
  })

  it('accepts the three that name none', () => {
    for (const type of ['openPage', 'hold', 'release']) expect(asBubbleRequest({ type })).toEqual({ type })
  })

  it('refuses a missing, empty, non-string or over-long id, and an id where none belongs', () => {
    expect(asBubbleRequest({ type: 'keep' })).toBeUndefined()
    expect(asBubbleRequest({ type: 'keep', id: '' })).toBeUndefined()
    expect(asBubbleRequest({ type: 'keep', id: 4 })).toBeUndefined()
    expect(asBubbleRequest({ type: 'keep', id: 'x'.repeat(65) })).toBeUndefined()
    expect(asBubbleRequest({ type: 'hold', id: 'a' })).toBeUndefined()
  })

  it('refuses a path, an unknown type, extra fields and anything that is not an object', () => {
    expect(asBubbleRequest({ type: 'keep', id: 'a', path: '/etc/passwd' })).toBeUndefined()
    expect(asBubbleRequest({ type: 'deleteFile', id: 'a' })).toBeUndefined()
    expect(asBubbleRequest({ type: 'toString', id: 'a' })).toBeUndefined()
    expect(asBubbleRequest('keep')).toBeUndefined()
    expect(asBubbleRequest(null)).toBeUndefined()
  })
})
