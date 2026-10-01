import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadEntry } from '../download-types.js'
import { DIR, harness, item } from './service-harness.js'

const HELD = join(DIR, 'Unconfirmed id1.download')

function heldDownload (name = 'setup.exe') {
  const made = harness()
  const first = item(name)
  const id = made.start(first)
  made.files.add(first.savePath)
  first.finish('completed')
  return { ...made, first, id }
}

describe('holding a dangerous file', () => {
  it('writes it under a temporary name, never its own, and lists it under its real name as held', () => {
    const { service, start } = harness()
    const first = item('setup.exe')
    start(first)
    expect(first.setSavePath).toHaveBeenCalledWith(HELD)
    expect(service.list()).toMatchObject([{ fileName: 'setup.exe', savePath: HELD, state: 'progressing', danger: true, held: true }])
  })

  it('holds a type the name does not give away when the content type does', () => {
    const { service, start } = harness()
    start(item('download.bin', 'application/x-msdownload'))
    expect(service.list()[0]).toMatchObject({ held: true, fileName: 'download.bin' })
  })

  it('does not hold an ordinary file, and does not hold when a save dialog chose the name', () => {
    const plain = harness()
    plain.start(item('report.pdf', 'application/pdf'))
    expect(plain.service.list()[0]).not.toHaveProperty('held')

    const asking = harness([], { askWhere: () => true })
    const exe = item('setup.exe')
    asking.start(exe)
    expect(exe.setSavePath).not.toHaveBeenCalled()
    exe.savePath = join(DIR, 'chosen.exe')
    exe.progress(10)
    expect(asking.service.list()[0]).toMatchObject({ danger: true, fileName: 'chosen.exe' })
    expect(asking.service.list()[0]).not.toHaveProperty('held')
  })

  it('keeps the real name and the temporary path while it arrives, and waits as held when it is whole', () => {
    const { service, start } = harness()
    const first = item('setup.exe')
    start(first)
    first.progress(40)
    expect(service.list()[0]).toMatchObject({ fileName: 'setup.exe', savePath: HELD, received: 40, state: 'progressing', held: true })
    first.finish('completed')
    expect(service.list()[0]).toMatchObject({ fileName: 'setup.exe', savePath: HELD, state: 'held', held: true, danger: true })
  })

  it('never opens or shows a held file, and neither removes nor retries it', async () => {
    const { service, id, deps } = heldDownload()
    expect(await service.open(id)).toBe(false)
    expect(service.showInFolder(id)).toBe(false)
    expect(service.remove(id)).toBe(false)
    expect(service.retry(id)).toBe(false)
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('leaves a held file in the list when the list is cleared', () => {
    const { service, id } = heldDownload()
    service.clear()
    expect(service.list().map((entry) => entry.id)).toEqual([id])
  })
})

describe('keep', () => {
  it('renames the file to its real name, in the same folder, and lists it as finished and dangerous', () => {
    const { service, id, deps, files } = heldDownload()
    expect(service.keep(id)).toBe(true)
    expect(deps.rename).toHaveBeenCalledWith(HELD, join(DIR, 'setup.exe'))
    expect(files.has(join(DIR, 'setup.exe'))).toBe(true)
    expect(service.list()[0]).toMatchObject({ state: 'completed', savePath: join(DIR, 'setup.exe'), fileName: 'setup.exe', danger: true })
    expect(service.list()[0]).not.toHaveProperty('held')
  })

  it('numbers the name when a file of that name is already there', () => {
    const { service, id, files } = heldDownload()
    files.add(join(DIR, 'setup.exe'))
    service.keep(id)
    expect(service.list()[0]).toMatchObject({ savePath: join(DIR, 'setup (1).exe'), fileName: 'setup (1).exe' })
  })

  it('still never opens the kept file', async () => {
    const { service, id, deps } = heldDownload()
    service.keep(id)
    expect(await service.open(id)).toBe(false)
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('refuses an entry that is not held, and an id it does not know', () => {
    const { service, start } = harness()
    const plain = item('report.pdf')
    const id = start(plain)
    plain.finish('completed')
    expect(service.keep(id)).toBe(false)
    expect(service.keep('nope')).toBe(false)
  })

  it('stays held when the rename fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service, id, deps } = heldDownload()
    vi.mocked(deps.rename).mockImplementation(() => { throw new Error('busy') })
    expect(service.keep(id)).toBe(false)
    expect(service.list()[0]?.state).toBe('held')
    error.mockRestore()
  })

  it('keeps a file whose name is long text in a language that takes several bytes a letter', () => {
    const { service, id, deps } = heldDownload(`${'漢'.repeat(150)}.exe`)
    expect(service.keep(id)).toBe(true)
    const kept = service.list()[0]?.fileName ?? ''
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(200)
    expect(deps.rename).toHaveBeenCalledWith(HELD, join(DIR, kept))
  })

  it('forgets a held download whose temporary file has gone', () => {
    const { service, id, files } = heldDownload()
    files.delete(HELD)
    expect(service.keep(id)).toBe(false)
    expect(service.list()).toEqual([])
  })
})

describe('discard', () => {
  it('deletes the temporary file and forgets the download', () => {
    const { service, id, deps, files } = heldDownload()
    const heard = vi.fn()
    service.onChange(heard)
    expect(service.discard(id)).toBe(true)
    expect(deps.removeFile).toHaveBeenCalledWith(HELD)
    expect(files.size).toBe(0)
    expect(service.list()).toEqual([])
    expect(heard).toHaveBeenCalledWith(null)
  })

  it('refuses an entry that is not held', () => {
    const { service, start, deps } = harness()
    const plain = item('report.pdf')
    const id = start(plain)
    plain.finish('completed')
    expect(service.discard(id)).toBe(false)
    expect(deps.removeFile).not.toHaveBeenCalled()
    expect(service.list()).toHaveLength(1)
  })
})

describe('a held download that does not arrive', () => {
  it('leaves nothing behind when it is cancelled', () => {
    const { service, start, deps } = harness()
    const first = item('setup.exe')
    const id = start(first)
    service.cancel(id)
    first.finish('cancelled')
    expect(deps.removeFile).toHaveBeenCalledWith(HELD)
    expect(service.list()[0]).toMatchObject({ state: 'cancelled' })
    expect(service.list()[0]).not.toHaveProperty('held')
  })

  it('leaves nothing behind when it breaks, and can be asked for again', () => {
    const { service, start, deps } = harness()
    const first = item('setup.exe')
    const id = start(first)
    first.received = 5
    first.finish('interrupted')
    expect(deps.removeFile).toHaveBeenCalledWith(HELD)
    expect(service.list()[0]).toMatchObject({ state: 'interrupted', reason: 'network' })
    expect(service.retry(id)).toBe(true)
  })

  it('ends the hold when another listener chose the path (Save page as)', () => {
    const { service, start } = harness()
    const first = item('setup.exe')
    start(first)
    first.savePath = join(DIR, 'mine.exe')
    first.finish('completed')
    expect(service.list()[0]).toMatchObject({ state: 'completed', fileName: 'mine.exe', savePath: join(DIR, 'mine.exe') })
    expect(service.list()[0]).not.toHaveProperty('held')
  })
})

describe('a restart', () => {
  const stored = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
    id: 'h', url: 'https://a.example/setup.exe', referrer: '', fileName: 'setup.exe', savePath: join(DIR, 'Unconfirmed h.download'), mime: 'application/octet-stream',
    total: 4096, received: 4096, state: 'held', startedAt: 1, danger: true, held: true, ...over
  })

  it('keeps a held file whose temporary file is still there, and keeps it answerable', () => {
    const files = new Set([stored().savePath])
    const again = harness([stored()], { fileExists: (path) => files.has(path) })
    expect(again.service.list()[0]?.state).toBe('held')
    expect(again.service.keep('h')).toBe(true)
  })

  it('drops a held file whose temporary file is gone', () => {
    const { service, written } = harness([stored()])
    expect(service.list()).toEqual([])
    expect(written.at(-1)).toEqual([])
  })

  it('deletes what a held download left half written and lists it as interrupted', () => {
    const { service, deps } = harness([stored({ state: 'progressing' })])
    expect(service.list()[0]).toMatchObject({ state: 'interrupted', reason: 'closed' })
    expect(service.list()[0]).not.toHaveProperty('held')
    expect(deps.removeFile).toHaveBeenCalledWith(stored().savePath)
  })
})

describe('a restart with a list that cannot be trusted', () => {
  const stored = (over: Partial<DownloadEntry>): DownloadEntry => ({
    id: 'h', url: 'https://a.example/setup.exe', referrer: '', fileName: 'setup.exe', savePath: join(DIR, 'Unconfirmed h.download'), mime: '',
    total: 4096, received: 4096, state: 'held', startedAt: 1, danger: true, held: true, ...over
  })

  it('deletes the temporary file of a hold that was interrupted, and lists the entry as an ordinary failure', () => {
    const { service, deps } = harness([stored({ state: 'interrupted', reason: 'network' })])
    expect(service.list()[0]).toMatchObject({ state: 'interrupted', reason: 'network' })
    expect(service.list()[0]).not.toHaveProperty('held')
    expect(deps.removeFile).toHaveBeenCalledWith(join(DIR, 'Unconfirmed h.download'))
  })

  it('touches nothing on disk for a held entry whose path is not a hold file, and drops the entry', () => {
    const stolen = ['/etc/passwd', join(DIR, 'notes.txt'), join('relative', 'Unconfirmed x.download'), join(DIR, 'Unconfirmed ../x.download')]
    const entries = stolen.flatMap((savePath, index) => ['held', 'progressing', 'interrupted'].map((state) => stored({ id: `${String(index)}${state}`, savePath, state: state as DownloadEntry['state'] })))
    const { service, deps } = harness(entries, { fileExists: () => true })
    expect(service.list()).toEqual([])
    expect(deps.removeFile).not.toHaveBeenCalled()
    expect(deps.rename).not.toHaveBeenCalled()
  })
})

describe('the end of a private session', () => {
  it('deletes every temporary file a hold left, whether it is waiting or still arriving', () => {
    const { service, start, deps, files } = harness()
    const arriving = item('a.exe')
    start(arriving)
    const waiting = item('b.exe')
    start(waiting)
    waiting.finish('completed')
    const plain = item('c.pdf')
    start(plain)
    files.add(arriving.savePath)
    files.add(waiting.savePath)
    service.discardHeldFiles()
    expect(deps.removeFile).toHaveBeenCalledTimes(2)
    expect(deps.removeFile).toHaveBeenCalledWith(arriving.savePath)
    expect(deps.removeFile).toHaveBeenCalledWith(waiting.savePath)
  })
})

describe('the hold has no stale entry in the list', () => {
  it('writes the held state to the stored list so a restart can find it', () => {
    const { written, id } = heldDownload()
    expect(id).not.toBe('')
    const last = written.at(-1) ?? []
    expect(last[0]).toMatchObject({ state: 'held', held: true })
  })
})
