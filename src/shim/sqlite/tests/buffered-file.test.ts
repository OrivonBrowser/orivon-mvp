import { describe, expect, it } from 'vitest'
import { bufferedFile } from '../buffered-file.js'
import type { SqliteFile } from '../files.js'

function recording (initial = 100): { file: SqliteFile, log: string[], bytes: () => Uint8Array } {
  let bytes = new Uint8Array(initial)
  const log: string[] = []
  const file: SqliteFile = {
    read: (position, length) => { log.push(`read ${String(position)} ${String(length)}`); return bytes.slice(position, position + length) },
    write: (position, data) => {
      log.push(`write ${String(position)} ${String(data.length)}`)
      if (position + data.length > bytes.length) { const grown = new Uint8Array(position + data.length); grown.set(bytes); bytes = grown }
      bytes.set(data, position)
    },
    size: () => { log.push('size'); return bytes.length },
    truncate: (length) => { log.push(`truncate ${String(length)}`); bytes = bytes.slice(0, length) },
    sync: () => { log.push('sync') },
    close: () => { log.push('close') }
  }
  return { file, log, bytes: () => bytes }
}

describe('bufferedFile', () => {
  it('merges writes that continue where the last ended, and writes them out at sync', () => {
    const { file, log, bytes } = recording()
    const buffered = bufferedFile(file)
    buffered.write(0, new Uint8Array([1, 2]))
    buffered.write(2, new Uint8Array([3]))
    buffered.write(3, new Uint8Array([4, 5]))
    expect(log).toEqual([])
    buffered.sync()
    expect(log).toEqual(['write 0 5', 'sync'])
    expect([...bytes().subarray(0, 6)]).toEqual([1, 2, 3, 4, 5, 0])
  })

  it('a write elsewhere writes out what was pending first, in order', () => {
    const { file, log } = recording()
    const buffered = bufferedFile(file)
    buffered.write(10, new Uint8Array([1]))
    buffered.write(50, new Uint8Array([2]))
    buffered.write(51, new Uint8Array([3]))
    buffered.close()
    expect(log).toEqual(['write 10 1', 'write 50 2', 'close'])
  })

  it('a read sees pending bytes, and a truncate comes after the writes before it', () => {
    const { file, log } = recording()
    const buffered = bufferedFile(file)
    buffered.write(0, new Uint8Array([7, 8]))
    expect([...buffered.read(0, 2)]).toEqual([7, 8])
    buffered.write(2, new Uint8Array([9]))
    buffered.truncate(2)
    expect(log).toEqual(['write 0 2', 'read 0 2', 'write 2 1', 'truncate 2'])
  })

  it('asks for the size once, and follows writes and truncates after that', () => {
    const { file, log } = recording(100)
    const buffered = bufferedFile(file)
    expect(buffered.size()).toBe(100)
    buffered.write(100, new Uint8Array(20))
    expect(buffered.size()).toBe(120)
    buffered.truncate(50)
    expect(buffered.size()).toBe(50)
    expect(log.filter((entry) => entry === 'size')).toHaveLength(1)
  })

  it('writes out once the pending bytes reach the limit', () => {
    const { file, log } = recording()
    const buffered = bufferedFile(file, 8)
    buffered.write(0, new Uint8Array(5))
    buffered.write(5, new Uint8Array(5))
    expect(log).toEqual(['write 0 10'])
  })

  it('a size asked for over pending writes is the size after them', () => {
    const { file } = recording(0)
    const buffered = bufferedFile(file)
    buffered.write(0, new Uint8Array(10))
    expect(buffered.size()).toBe(10)
  })
})
