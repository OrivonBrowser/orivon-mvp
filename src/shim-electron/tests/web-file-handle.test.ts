import { describe, expect, it } from 'vitest'
import { fileHandleFromWeb, type WebFileHandle } from '../web-file-handle.js'

/** A web file handle over a byte array: a writer's changes show in `getFile()` only once it closes, as the platform's do. */
function fakeWebFile (initial = '') {
  let committed = new TextEncoder().encode(initial)
  const log: string[] = []
  const handle: WebFileHandle = {
    name: 'saved.txt',
    getFile: async () => new File([committed.slice()], 'saved.txt', { lastModified: 42 }),
    createWritable: async () => {
      log.push('createWritable')
      let pending = committed.slice()
      return {
        write: async ({ position, data }) => {
          const grown = new Uint8Array(Math.max(pending.length, position + data.length))
          grown.set(pending)
          grown.set(data, position)
          pending = grown
        },
        truncate: async (size) => { const next = new Uint8Array(size); next.set(pending.subarray(0, size)); pending = next },
        close: async () => { log.push('close'); committed = pending }
      }
    }
  }
  return { handle, log, committed: () => new TextDecoder().decode(committed) }
}

describe('a saved-to file as a FileHandle', () => {
  it('carries the browser\'s name for the file', () => {
    expect(fileHandleFromWeb(fakeWebFile('x').handle).name).toBe('saved.txt')
  })

  it('writes through one writer and commits only when synced or closed', async () => {
    const web = fakeWebFile('old content here')
    const file = fileHandleFromWeb(web.handle)
    await file.truncate(0)
    await file.write({ position: 0, data: new TextEncoder().encode('new') })
    await file.write({ position: 3, data: new TextEncoder().encode('er') })
    expect(web.committed()).toBe('old content here')
    expect(web.log).toEqual(['createWritable'])
    await file.sync()
    expect(web.committed()).toBe('newer')
    await file.write({ position: 5, data: new TextEncoder().encode('!') })
    await file.close()
    expect(web.committed()).toBe('newer!')
  })

  it('a read or stat sees what was written before it, by committing first', async () => {
    const web = fakeWebFile('')
    const file = fileHandleFromWeb(web.handle)
    await file.write({ position: 0, data: new TextEncoder().encode('abcdef') })
    expect(new TextDecoder().decode(await file.read({ position: 2, length: 3 }))).toBe('cde')
    expect(await file.stat()).toEqual({ size: 6, isFile: true, isDirectory: false, mtimeMs: 42 })
  })

  it('parallel writes share one writer instead of racing to open two', async () => {
    const web = fakeWebFile('')
    const file = fileHandleFromWeb(web.handle)
    await Promise.all([0, 1, 2, 3].map(async (index) => await file.write({ position: index, data: new Uint8Array([65 + index]) })))
    await file.close()
    expect(web.committed()).toBe('ABCD')
    expect(web.log.filter((entry) => entry === 'createWritable')).toHaveLength(1)
  })

  it('a failure of the web call comes out as an Orivon error with a code the Node shim maps', async () => {
    const handle: WebFileHandle = {
      name: 'x', getFile: async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundError' }) },
      createWritable: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) }
    }
    const file = fileHandleFromWeb(handle)
    await expect(file.read({ position: 0, length: 1 })).rejects.toMatchObject({ code: 'notFound' })
    await expect(file.write({ position: 0, data: new Uint8Array(1) })).rejects.toMatchObject({ code: 'denied' })
  })

  it('closing settles `closed`', async () => {
    const file = fileHandleFromWeb(fakeWebFile().handle)
    await file.close()
    await expect(file.closed).resolves.toBeUndefined()
  })

  it('a commit that throws keeps the pending writes, and the next commit tries them again', async () => {
    let failures = 1
    let committed = ''
    let pending = ''
    const handle: WebFileHandle = {
      name: 'x', getFile: async () => new File([committed], 'x'),
      createWritable: async () => ({
        write: async ({ data }) => { pending += new TextDecoder().decode(data) },
        truncate: async () => {},
        close: async () => { if (failures-- > 0) throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }); committed = pending }
      })
    }
    const file = fileHandleFromWeb(handle)
    await file.write({ position: 0, data: new TextEncoder().encode('kept') })
    await expect(file.sync()).rejects.toMatchObject({ code: 'limit' })
    expect(committed).toBe('')
    await file.sync()
    expect(committed).toBe('kept')
  })
})
