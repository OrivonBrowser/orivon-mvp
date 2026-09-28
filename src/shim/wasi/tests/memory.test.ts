import { describe, expect, it } from 'vitest'
import { DIRENT_SIZE, GuestMemory, InvalidUtf8, encodeDirent, unsigned } from '../memory.js'
import { lineSink } from '../stdio.js'

function bound (): { guest: GuestMemory, view: () => DataView } {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const guest = new GuestMemory()
  guest.bind(memory)
  return { guest, view: () => new DataView(memory.buffer) }
}

describe('GuestMemory', () => {
  it('refuses to be used before a memory is bound', () => {
    expect(() => new GuestMemory().view).toThrow(/bindMemory/)
  })

  it('reads iovecs, and gathers and scatters across them in order', () => {
    const { guest, view } = bound()
    view().setUint32(0, 100, true)
    view().setUint32(4, 3, true)
    view().setUint32(8, 200, true)
    view().setUint32(12, 2, true)
    const iovecs = guest.iovecs(0, 2)
    expect(iovecs).toEqual([{ ptr: 100, len: 3 }, { ptr: 200, len: 2 }])
    expect(guest.scatter(iovecs, new TextEncoder().encode('hello!'))).toBe(5)
    expect(new TextDecoder().decode(guest.gather(iovecs))).toBe('hello')
  })

  it('lays out a filestat at the witx offsets', () => {
    const { guest, view } = bound()
    guest.filestat(64, { ino: 7n, filetype: 4, size: 1234n, mtimNs: 99n })
    expect(view().getBigUint64(64 + 8, true)).toBe(7n)
    expect(view().getUint8(64 + 16)).toBe(4)
    expect(view().getBigUint64(64 + 24, true)).toBe(1n)
    expect(view().getBigUint64(64 + 32, true)).toBe(1234n)
    expect(view().getBigUint64(64 + 48, true)).toBe(99n)
  })

  it('lays out an fdstat at the witx offsets', () => {
    const { guest, view } = bound()
    guest.fdstat(32, { filetype: 3, flags: 1, rightsBase: 0x55n, rightsInheriting: 0xaan })
    expect(view().getUint8(32)).toBe(3)
    expect(view().getUint16(34, true)).toBe(1)
    expect(view().getBigUint64(40, true)).toBe(0x55n)
    expect(view().getBigUint64(48, true)).toBe(0xaan)
  })

  it('throws RangeError past the end of memory, which the host reports as FAULT', () => {
    const { guest } = bound()
    expect(() => guest.bytes(65_530, 10)).toThrow(RangeError)
  })

  it('reads an i32 pointer above 2 GiB, which arrives negative, as unsigned', () => {
    expect(unsigned(-2_147_483_648)).toBe(2_147_483_648)
    expect(unsigned(-1)).toBe(4_294_967_295)
    expect(() => bound().guest.bytes(-8, 4)).toThrow(RangeError)
  })

  it('throws InvalidUtf8 for a path that is not UTF-8', () => {
    const { guest } = bound()
    guest.bytes(0, 2).set([0xff, 0xfe])
    expect(() => guest.string(0, 2)).toThrow(InvalidUtf8)
  })
})

describe('encodeDirent', () => {
  it('writes d_next, d_ino, d_namlen and d_type, then the name', () => {
    const record = encodeDirent(5n, 9n, new TextEncoder().encode('abc'), 4)
    const view = new DataView(record.buffer)
    expect(record.length).toBe(DIRENT_SIZE + 3)
    expect(view.getBigUint64(0, true)).toBe(5n)
    expect(view.getBigUint64(8, true)).toBe(9n)
    expect(view.getUint32(16, true)).toBe(3)
    expect(view.getUint8(20)).toBe(4)
    expect(new TextDecoder().decode(record.subarray(DIRENT_SIZE))).toBe('abc')
  })
})

describe('lineSink', () => {
  it('emits one entry per line, holding a character split across two writes', () => {
    const lines: string[] = []
    const { sink, flush } = lineSink((line) => lines.push(line))
    const bytes = new TextEncoder().encode('café\nsecond')
    void sink(bytes.subarray(0, 4))
    void sink(bytes.subarray(4))
    expect(lines).toEqual(['café'])
    flush()
    expect(lines).toEqual(['café', 'second'])
  })
})
