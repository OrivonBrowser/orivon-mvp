import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DownloadService, MAX_RUNNING_PER_TAB } from '../download-service.js'
import type { DownloadDeps } from '../download-service.js'
import type { DownloadStore } from '../download-store.js'
import type { DownloadEntry } from '../download-types.js'
import { fakeContents, FakeItem } from './fake-item.js'

const DIR = join('/', 'dl')

function harness (stored: DownloadEntry[] = [], over: Partial<DownloadDeps> = {}) {
  const files = new Set<string>()
  const written: DownloadEntry[][] = []
  const store: DownloadStore = { read: () => stored, write: (entries) => { written.push([...entries]) }, flush: async () => {} }
  let clock = 1000
  let counter = 0
  const deps: DownloadDeps = {
    folder: () => DIR,
    fallbackFolder: () => join('/', 'system'),
    askWhere: () => false,
    fileExists: (path) => files.has(path),
    ensureFolder: vi.fn(() => true),
    folderWritable: () => true,
    openPath: vi.fn(async () => ''),
    showInFolder: vi.fn(),
    trash: vi.fn(async (path: string) => { files.delete(path) }),
    fetchAgain: vi.fn(),
    now: () => { clock += 1; return clock },
    newId: () => { counter += 1; return `id${String(counter)}` },
    ...over
  }
  const service = new DownloadService(store, deps)
  const event = { preventDefault: vi.fn() }
  const start = (item: FakeItem, tab = 1): string => {
    const seen: string[] = []
    const off = service.onStart((info) => { seen.push(info.id) })
    service.track(item.asItem(), fakeContents(tab), event)
    off()
    return seen[0] ?? ''
  }
  return { service, deps, files, written, event, start }
}

const item = (name = 'file.bin', mime?: string, total?: number): FakeItem => new FakeItem(name, ['https://a.example/' + name], mime, total)

describe('starting a download', () => {
  it('sets the save path before it returns, inside the folder, and lists the download', () => {
    const { service, start } = harness()
    const first = item()
    const id = start(first)
    expect(first.setSavePath).toHaveBeenCalledWith(join(DIR, 'file.bin'))
    expect(service.list()).toMatchObject([{ id, fileName: 'file.bin', savePath: join(DIR, 'file.bin'), state: 'progressing', url: 'https://a.example/file.bin', referrer: 'https://site.example/page', danger: false }])
  })

  it('numbers a name that is taken on disk or by a download in progress', () => {
    const { files, start, service } = harness()
    files.add(join(DIR, 'file.bin'))
    const a = item()
    const b = item()
    start(a)
    start(b)
    expect(a.setSavePath).toHaveBeenCalledWith(join(DIR, 'file (1).bin'))
    expect(b.setSavePath).toHaveBeenCalledWith(join(DIR, 'file (2).bin'))
    expect(service.list()).toHaveLength(2)
  })

  it('makes the name safe before it joins it to the folder', () => {
    const { start } = harness()
    const evil = item('../../etc/passwd')
    start(evil)
    expect(evil.setSavePath).toHaveBeenCalledWith(join(DIR, 'passwd'))
  })

  it('saves to the system folder when the chosen one cannot be made', () => {
    const { start, deps } = harness([], { ensureFolder: vi.fn((dir: string) => dir !== DIR) })
    const first = item()
    start(first)
    expect(first.setSavePath).toHaveBeenCalledWith(join('/', 'system', 'file.bin'))
    expect(deps.ensureFolder).toHaveBeenCalledWith(DIR)
  })

  it('marks a type that runs code as dangerous', () => {
    const { service, start } = harness()
    start(item('setup.exe'))
    start(item('download.bin', 'application/x-msdownload'))
    start(item('photo.jpg.exe'))
    expect(service.list().map((entry) => entry.danger)).toEqual([true, true, true])
  })

  it('tells the listeners after the path is set, and lets one cancel', () => {
    const { service, start } = harness()
    const order: string[] = []
    const first = item()
    first.setSavePath.mockImplementation((path: string) => { order.push('path'); first.savePath = path })
    service.onStart((info) => { order.push('start'); info.item.cancel() })
    start(first)
    expect(order).toEqual(['path', 'start'])
    expect(first.cancel).toHaveBeenCalled()
  })

  it('keeps going when a start listener throws', () => {
    const { service, start } = harness()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.onStart(() => { throw new Error('nope') })
    start(item())
    expect(service.list()).toHaveLength(1)
    error.mockRestore()
  })
})

describe('the flood guard', () => {
  it('refuses the download past ten in one tab and records it once', () => {
    const { service, start, event } = harness()
    for (let count = 0; count < MAX_RUNNING_PER_TAB; count += 1) start(item(`f${String(count)}.bin`), 7)
    const refused = item('x.bin')
    start(refused, 7)
    start(item('y.bin'), 7)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(refused.setSavePath).not.toHaveBeenCalled()
    const failures = service.list().filter((entry) => entry.reason === 'flood')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ state: 'interrupted', fileName: 'x.bin' })
  })

  it('does not count another tab, nor downloads that have finished', () => {
    const { service, start, event } = harness()
    const first = Array.from({ length: MAX_RUNNING_PER_TAB }, (_, count) => item(`f${String(count)}.bin`))
    first.forEach((download) => start(download, 1))
    start(item('other.bin'), 2)
    first[0]?.finish('completed')
    start(item('again.bin'), 1)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(service.list().filter((entry) => entry.state === 'progressing')).toHaveLength(MAX_RUNNING_PER_TAB + 1)
  })
})

describe('progress and the end of a download', () => {
  it('follows the item and tells the listeners', () => {
    const { service, start } = harness()
    const changes: unknown[] = []
    service.onChange((change) => changes.push(change))
    const first = item('f.bin', undefined, 100)
    const id = start(first)
    first.speed = 10
    first.progress(40)
    expect(service.list()[0]).toMatchObject({ id, received: 40, total: 100, speed: 10, state: 'progressing' })
    expect(changes.at(-1)).toMatchObject({ id, received: 40 })
    expect(service.summary()).toEqual({ active: 1, fraction: 0.4, any: true })
  })

  it('completes, and keeps the list on disk at the start and at the end', () => {
    const { service, start, written } = harness()
    const first = item()
    start(first)
    first.finish('completed')
    expect(service.list()[0]).toMatchObject({ state: 'completed', received: 100, total: 100 })
    expect(service.list()[0]?.endedAt).toBeDefined()
    expect(written.length).toBe(2)
  })

  it('takes the path another listener chose over its own', () => {
    const { service, start } = harness()
    const first = item('page.html')
    start(first)
    first.savePath = join('/', 'chosen', 'My page.html')
    first.progress(10)
    expect(service.list()[0]).toMatchObject({ savePath: join('/', 'chosen', 'My page.html'), fileName: 'My page.html' })
  })

  it('reports why an interruption happened: disk, server or network', () => {
    const writable = { value: true }
    const { service, start } = harness([], { folderWritable: () => writable.value })
    const none = item('a.bin')
    start(none)
    none.finish('interrupted')
    const some = item('b.bin')
    start(some)
    some.received = 50
    some.finish('interrupted')
    writable.value = false
    const full = item('c.bin')
    start(full)
    full.received = 50
    full.finish('interrupted')
    expect(service.list().map((entry) => entry.reason)).toEqual(['disk', 'network', 'server'])
  })

  it('shows a resumable interruption as interrupted, and resumes it on retry', () => {
    const { service, start, deps } = harness()
    const first = item()
    const id = start(first)
    first.resumable = true
    first.received = 30
    first.emit('updated', {}, 'interrupted')
    expect(service.list()[0]).toMatchObject({ state: 'interrupted', reason: 'network' })
    expect(service.retry(id)).toBe(true)
    expect(first.resume).toHaveBeenCalled()
    expect(service.list()[0]).toMatchObject({ state: 'progressing' })
    expect(service.list()[0]).not.toHaveProperty('reason')
    expect(deps.fetchAgain).not.toHaveBeenCalled()
  })
})

describe('pause, resume and cancel', () => {
  it('pauses and resumes through the item', () => {
    const { service, start } = harness()
    const first = item()
    const id = start(first)
    expect(service.pause(id)).toBe(true)
    expect(first.pause).toHaveBeenCalled()
    expect(service.list()[0]?.state).toBe('paused')
    expect(service.summary().active).toBe(1)
    expect(service.resume(id)).toBe(true)
    expect(service.list()[0]?.state).toBe('progressing')
  })

  it('cancels and lists it as cancelled, with nothing left to pause', () => {
    const { service, start } = harness()
    const first = item()
    const id = start(first)
    expect(service.cancel(id)).toBe(true)
    first.finish('cancelled')
    expect(service.list()[0]?.state).toBe('cancelled')
    expect(service.pause(id)).toBe(false)
    expect(service.cancel(id)).toBe(false)
  })

  it('refuses an id it does not know', () => {
    const { service } = harness()
    expect(service.pause('nope')).toBe(false)
    expect(service.resume('nope')).toBe(false)
    expect(service.cancel('nope')).toBe(false)
    expect(service.retry('nope')).toBe(false)
    expect(service.remove('nope')).toBe(false)
  })
})

describe('retry', () => {
  it('asks for the address again and replaces the old entry when the new download starts', () => {
    const { service, start, deps } = harness()
    const first = item('f.bin')
    const oldId = start(first)
    first.finish('cancelled')
    expect(service.retry(oldId)).toBe(true)
    expect(deps.fetchAgain).toHaveBeenCalledWith('https://a.example/f.bin')
    expect(service.list().map((entry) => entry.id)).toEqual([oldId])
    const again = item('f.bin')
    const newId = start(again)
    expect(service.list().map((entry) => entry.id)).toEqual([newId])
  })

  it('refuses an address that is not http or https, and a download still running', () => {
    const { service, start } = harness()
    const blob = new FakeItem('x.txt', ['blob:https://a.example/1'])
    const id = start(blob)
    blob.finish('interrupted')
    expect(service.retry(id)).toBe(false)
    const live = item()
    expect(service.retry(start(live))).toBe(false)
  })
})

describe('the list', () => {
  it('turns a download a previous run left running into an interrupted one', () => {
    const left: DownloadEntry = { id: 'old', url: 'https://a.example/f', referrer: '', fileName: 'f', savePath: '/d/f', mime: '', total: 10, received: 4, state: 'progressing', startedAt: 1, danger: false }
    const paused: DownloadEntry = { ...left, id: 'old2', state: 'paused' }
    const { service, written } = harness([left, paused])
    expect(service.list().map((entry) => [entry.state, entry.reason])).toEqual([['interrupted', 'closed'], ['interrupted', 'closed']])
    expect(written).toHaveLength(1)
    expect(service.summary().active).toBe(0)
  })

  it('writes nothing at start when every stored entry is already settled', () => {
    const done: DownloadEntry = { id: 'a', url: 'https://a.example/f', referrer: '', fileName: 'f', savePath: '/d/f', mime: '', total: 1, received: 1, state: 'completed', startedAt: 1, danger: false }
    expect(harness([done]).written).toHaveLength(0)
  })

  it('marks a finished download whose file is gone, and stops when it comes back', () => {
    let time = 0
    const { service, start, files } = harness([], { now: () => time })
    const first = item()
    start(first)
    files.add(join(DIR, 'file.bin'))
    first.finish('completed')
    expect(service.list()[0]).not.toHaveProperty('missing')
    files.delete(join(DIR, 'file.bin'))
    time += 5000
    expect(service.list()[0]?.missing).toBe(true)
  })

  it('removes one finished download and keeps the file, and refuses a running one', () => {
    const { service, start, files } = harness()
    const first = item()
    const id = start(first)
    expect(service.remove(id)).toBe(false)
    files.add(join(DIR, 'file.bin'))
    first.finish('completed')
    expect(service.remove(id)).toBe(true)
    expect(service.list()).toEqual([])
    expect(files.has(join(DIR, 'file.bin'))).toBe(true)
  })

  it('clears everything but what is running', () => {
    const { service, start } = harness()
    const done = item('a.bin')
    const running = item('b.bin')
    const failed = item('c.bin')
    start(done)
    const runningId = start(running)
    start(failed)
    done.finish('completed')
    failed.finish('interrupted')
    service.clear()
    expect(service.list().map((entry) => entry.id)).toEqual([runningId])
  })
})

describe('opening, showing and deleting a file', () => {
  const finished = (name: string, mime?: string) => {
    const made = harness()
    const first = item(name, mime)
    const id = made.start(first)
    made.files.add(first.savePath)
    first.finish('completed')
    return { ...made, id, path: first.savePath }
  }

  it('opens a finished file through the system, by id', async () => {
    const { service, id, path, deps } = finished('report.pdf')
    expect(await service.open(id)).toBe(true)
    expect(deps.openPath).toHaveBeenCalledWith(path)
  })

  it('never opens a dangerous type, but still shows it in its folder', async () => {
    const { service, id, path, deps } = finished('setup.exe')
    expect(await service.open(id)).toBe(false)
    expect(deps.openPath).not.toHaveBeenCalled()
    expect(service.showInFolder(id)).toBe(true)
    expect(deps.showInFolder).toHaveBeenCalledWith(path)
  })

  it('refuses a file that is gone, and one that is not finished', async () => {
    const { service, id, files, path, deps, start } = finished('report.pdf')
    files.delete(path)
    expect(await service.open(id)).toBe(false)
    expect(service.showInFolder(id)).toBe(false)
    const running = start(item('live.bin'))
    expect(await service.open(running)).toBe(false)
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('moves a file to the trash and then lists it as gone', async () => {
    let time = 0
    const { service, id, path, deps } = (() => {
      const made = harness([], { now: () => time })
      const first = item('report.pdf')
      const id = made.start(first)
      made.files.add(first.savePath)
      first.finish('completed')
      return { ...made, id, path: first.savePath }
    })()
    expect(await service.deleteFile(id)).toBe(true)
    expect(deps.trash).toHaveBeenCalledWith(path)
    time += 5000
    expect(service.list()[0]?.missing).toBe(true)
  })
})

describe('a save dialog', () => {
  it('asks Electron for its own dialog, in the folder of the last answer, and lists the download once it is answered', () => {
    const { service, start } = harness([], { askWhere: () => true })
    const first = item('f.bin')
    start(first)
    expect(first.setSavePath).not.toHaveBeenCalled()
    expect(first.setSaveDialogOptions).toHaveBeenCalledWith({ title: 'Save file', defaultPath: join(DIR, 'f.bin') })
    expect(service.list()).toEqual([])
    first.savePath = join('/', 'picked', 'f.bin')
    first.progress(10)
    expect(service.list()).toMatchObject([{ savePath: join('/', 'picked', 'f.bin'), state: 'progressing' }])
    const second = item('g.bin')
    start(second)
    expect(second.setSaveDialogOptions).toHaveBeenCalledWith({ title: 'Save file', defaultPath: join('/', 'picked', 'g.bin') })
  })

  it('drops a download whose dialog was dismissed, without an entry', () => {
    const { service, start } = harness([], { askWhere: () => true })
    const first = item()
    start(first)
    first.finish('cancelled')
    expect(service.list()).toEqual([])
  })
})
