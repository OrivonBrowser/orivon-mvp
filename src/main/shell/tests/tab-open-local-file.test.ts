import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabOpenerHost } from '../tab-open.js'
import type { TabFactory } from '../tab-factory.js'

const known = vi.hoisted(() => ({ fuse: undefined as 'off' | 'on' | 'unknown' | undefined, reads: 0, answer: 'off' as 'off' | 'on' | 'unknown' }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => known.fuse,
  fileProtocolFuse: () => { known.reads += 1; known.fuse = known.answer; return Promise.resolve(known.answer) }
}))

const { TabOpener } = await import('../tab-open.js')

const FILE = 'file:///home/u/notes/app.html'

function setup (capacity = false): { opener: InstanceType<typeof TabOpener>, add: ReturnType<typeof vi.fn>, refused: ReturnType<typeof vi.fn>, localFile: ReturnType<typeof vi.fn> } {
  const add = vi.fn()
  const refused = vi.fn()
  const contents = { loadURL: vi.fn(() => Promise.resolve()) }
  const host: TabOpenerHost = {
    add, activate: vi.fn(), changed: vi.fn(), atCapacity: () => capacity, activeId: () => 'front', records: () => [], localFilesRefused: refused
  }
  const localFile = vi.fn(() => ({ id: 't1', target: FILE, record: { view: { webContents: contents } } }))
  return { opener: new TabOpener(host, { localFile } as unknown as TabFactory), add, refused, localFile }
}

beforeEach(() => { known.fuse = 'off'; known.reads = 0; known.answer = 'off' })

describe('TabOpener.openLocalFile and the binary\'s file-protocol fuse', () => {
  it('opens a tab while the fuse is known to be off, without reading the binary again', async () => {
    const { opener, add, refused } = setup()
    expect(await opener.openLocalFile(FILE)).toBe('t1')
    expect(known.reads).toBe(0)
    expect(add).toHaveBeenCalledOnce()
    expect(refused).not.toHaveBeenCalled()
  })

  it.each(['on', 'unknown'] as const)('opens no tab and says so while the fuse reads %s', async (fuse) => {
    known.fuse = fuse
    const { opener, add, refused, localFile } = setup()

    expect(await opener.openLocalFile(FILE)).toBeUndefined()
    expect(known.reads).toBe(0)
    expect(add).not.toHaveBeenCalled()
    expect(localFile).not.toHaveBeenCalled()
    expect(refused).toHaveBeenCalledOnce()
  })

  it('reads the binary on the first open only, then opens when the fuse is off', async () => {
    known.fuse = undefined
    const { opener, add } = setup()
    expect(await opener.openLocalFile(FILE)).toBe('t1')
    expect(await opener.openLocalFile(FILE)).toBe('t1')
    expect(known.reads).toBe(1)
    expect(add).toHaveBeenCalledTimes(2)
  })

  it.each(['on', 'unknown'] as const)('refuses the first open when the first read says %s', async (answer) => {
    known.fuse = undefined
    known.answer = answer
    const { opener, add, refused } = setup()
    expect(await opener.openLocalFile(FILE)).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
    expect(refused).toHaveBeenCalledOnce()
  })

  it('opens nothing at the tab limit, reads nothing and says nothing about the fuse then', async () => {
    known.fuse = undefined
    const { opener, refused } = setup(true)
    expect(await opener.openLocalFile(FILE)).toBeUndefined()
    expect(known.reads).toBe(0)
    expect(refused).not.toHaveBeenCalled()
  })
})
