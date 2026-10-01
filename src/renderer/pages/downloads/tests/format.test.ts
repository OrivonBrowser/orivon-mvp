import { describe, expect, it } from 'vitest'
import type { DownloadEntry } from '../../../../main/downloads/download-types.js'
import { formatBytes, formatSpeed, formatTimeLeft, fractionOf, groupByStartDay, reasonText, sourceLabel, statusLine } from '../format.js'

const entry = (over: Partial<DownloadEntry>): DownloadEntry => ({
  id: 'a', url: 'https://files.example/a.bin', referrer: '', fileName: 'a.bin', savePath: '/d/a.bin', mime: '', total: 0, received: 0,
  state: 'progressing', startedAt: 0, danger: false, ...over
})
const MB = 1024 * 1024

describe('formatBytes and formatSpeed', () => {
  it('uses one decimal below ten, none from ten up, and none for a round number', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(80 * MB)).toBe('80 MB')
    expect(formatBytes(12.4 * MB)).toBe('12 MB')
    expect(formatBytes(200 * 1024)).toBe('200 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(4.25 * MB)).toBe('4.3 MB')
    expect(formatBytes(3 * 1024 * MB)).toBe('3 GB')
    expect(formatBytes(1023.6 * 1024)).toBe('1 MB')
    expect(formatBytes(-5)).toBe('0 B')
  })

  it('says a speed per second', () => {
    expect(formatSpeed(2.1 * MB)).toBe('2.1 MB/s')
  })
})

describe('formatTimeLeft', () => {
  it.each([
    [0, '1 s left'], [30, '30 s left'], [59, '59 s left'], [60, '1 min left'], [61, '2 min left'], [600, '10 min left'], [3600, '1 h left'], [3900, '1 h 5 min left']
  ])('%s seconds is %s', (seconds, text) => { expect(formatTimeLeft(seconds)).toBe(text) })
})

describe('statusLine', () => {
  it('gives progress, speed and time left', () => {
    expect(statusLine(entry({ received: 12.4 * MB, total: 80 * MB, speed: 2.1 * MB }))).toBe('12 MB of 80 MB · 2.1 MB/s · 33 s left')
  })

  it('leaves out what is not known: no speed yet, or no total', () => {
    expect(statusLine(entry({ received: 12.4 * MB, total: 80 * MB }))).toBe('12 MB of 80 MB')
    expect(statusLine(entry({ received: 12.4 * MB, speed: 2.1 * MB }))).toBe('12 MB · 2.1 MB/s')
  })

  it('says paused, with how far it got', () => {
    expect(statusLine(entry({ state: 'paused', received: 12.4 * MB, total: 80 * MB }))).toBe('Paused · 12 MB of 80 MB')
    expect(statusLine(entry({ state: 'paused', received: 12.4 * MB }))).toBe('Paused · 12 MB')
  })

  it('gives the size of a finished file, or says it is gone', () => {
    expect(statusLine(entry({ state: 'completed', total: 80 * MB, received: 80 * MB }))).toBe('80 MB')
    expect(statusLine(entry({ state: 'completed', total: 0, received: 2.5 * MB }))).toBe('2.5 MB')
    expect(statusLine(entry({ state: 'completed', total: 80 * MB, missing: true }))).toBe('Moved or deleted')
  })

  it('says cancelled, and leaves a failure to its badge', () => {
    expect(statusLine(entry({ state: 'cancelled' }))).toBe('Cancelled')
    expect(statusLine(entry({ state: 'interrupted' }))).toBe('')
  })
})

describe('reasonText', () => {
  it('has the words for every reason, and a default', () => {
    expect(reasonText('network')).toBe('Network error')
    expect(reasonText('disk')).toBe('Disk full or no permission')
    expect(reasonText('server')).toBe('The server stopped the download')
    expect(reasonText('closed')).toBe('Orivon closed before it finished')
    expect(reasonText('flood')).toBe('Too many downloads from this site')
    expect(reasonText(undefined)).toBe('Network error')
  })
})

describe('fractionOf and sourceLabel', () => {
  it('knows the share only when the size is known, and never passes one', () => {
    expect(fractionOf({ received: 25, total: 100 })).toBe(0.25)
    expect(fractionOf({ received: 25, total: 0 })).toBeNull()
    expect(fractionOf({ received: 200, total: 100 })).toBe(1)
  })

  it('shows the host, or the scheme when there is none', () => {
    expect(sourceLabel('https://files.example/a/b.bin?x=1')).toBe('files.example')
    expect(sourceLabel('blob:https://a.example/1')).toBe('blob:')
    expect(sourceLabel('not a url')).toBe('not a url')
  })
})

describe('groupByStartDay', () => {
  it('puts downloads of one day under one heading, in the order given', () => {
    const now = new Date(2026, 8, 30, 12).getTime()
    const hour = 3_600_000
    const groups = groupByStartDay([
      entry({ id: 'a', startedAt: now - hour }),
      entry({ id: 'b', startedAt: now - 2 * hour }),
      entry({ id: 'c', startedAt: now - 30 * hour })
    ], now, 'en-US')
    expect(groups.map((group) => [group.label, group.entries.map((item) => item.id)])).toEqual([['Today', ['a', 'b']], ['Yesterday', ['c']]])
  })
})

describe('statusLine of a held file', () => {
  it('says why it waits', () => {
    expect(statusLine({ state: 'held', total: 10, received: 10, danger: true } as DownloadEntry)).toBe('This type of file can harm your computer.')
  })
})
