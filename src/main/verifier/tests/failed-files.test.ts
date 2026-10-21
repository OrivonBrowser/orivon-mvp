import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FailedFiles, MAX_FAILED_PER_PAGE, noteCompletedFile } from '../failed-files.js'
import type { NavigatingTab } from '../failed-files.js'

const tab = (): NavigatingTab & EventEmitter => new EventEmitter()

describe('the files a page asked for and did not get', () => {
  it('counts each file once, however often it fails', () => {
    const files = new FailedFiles<NavigatingTab & EventEmitter>()
    const page = tab()
    files.add(page, 'https://x.eth/app.css')
    files.add(page, 'https://x.eth/app.css')
    files.add(page, 'https://x.eth/app.js')
    expect(files.count(page)).toBe(2)
  })

  it('forgets a file that later arrives, and all of them when the tab loads another document', () => {
    const files = new FailedFiles<NavigatingTab & EventEmitter>()
    const page = tab()
    files.add(page, 'https://x.eth/app.css')
    files.add(page, 'https://x.eth/app.js')
    files.arrived(page, 'https://x.eth/app.css')
    expect(files.count(page)).toBe(1)
    page.emit('did-navigate')
    expect(files.count(page)).toBe(0)
  })

  it('tells a listener of each change and of nothing else, and is capped for a page that fails in a loop', () => {
    const files = new FailedFiles<NavigatingTab & EventEmitter>()
    const page = tab()
    const heard = vi.fn()
    const stop = files.onChange(heard)
    files.add(page, 'https://x.eth/a')
    files.add(page, 'https://x.eth/a')
    files.arrived(page, 'https://x.eth/never-failed')
    expect(heard).toHaveBeenCalledTimes(1)
    for (let i = 0; i < MAX_FAILED_PER_PAGE + 10; i++) files.add(page, `https://x.eth/${String(i)}`)
    expect(files.count(page)).toBe(MAX_FAILED_PER_PAGE)
    stop()
    files.add(page, 'https://x.eth/after')
    expect(heard).toHaveBeenCalledTimes(MAX_FAILED_PER_PAGE)
  })
})

describe('noteCompletedFile', () => {
  const rig = () => {
    const files = new FailedFiles<NavigatingTab & EventEmitter>()
    const page = tab()
    const pages = new Map([[7, page]])
    return { files, page, note: (details: Parameters<typeof noteCompletedFile>[1]) => { noteCompletedFile(files, details, (id) => pages.get(id)) } }
  }

  it('notes a stylesheet the verifier answered with a failure, and forgets it when it arrives', () => {
    const { files, page, note } = rig()
    note({ url: 'https://x.eth/app.css', resourceType: 'stylesheet', statusCode: 502, webContentsId: 7 })
    expect(files.count(page)).toBe(1)
    note({ url: 'https://x.eth/app.css', resourceType: 'stylesheet', statusCode: 200, webContentsId: 7 })
    expect(files.count(page)).toBe(0)
  })

  it('does not count a file the site lacks (404), a document or a frame, or a request of no tab', () => {
    const { files, page, note } = rig()
    note({ url: 'https://x.eth/missing.png', resourceType: 'image', statusCode: 404, webContentsId: 7 })
    note({ url: 'https://x.eth/', resourceType: 'mainFrame', statusCode: 502, webContentsId: 7 })
    note({ url: 'https://x.eth/f', resourceType: 'subFrame', statusCode: 502, webContentsId: 7 })
    note({ url: 'https://x.eth/w.js', resourceType: 'script', statusCode: 502 })
    note({ url: 'https://x.eth/w.js', resourceType: 'script', statusCode: 502, webContentsId: 99 })
    expect(files.count(page)).toBe(0)
  })
})
