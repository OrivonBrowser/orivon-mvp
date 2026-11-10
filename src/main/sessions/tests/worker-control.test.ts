import { describe, expect, it, vi } from 'vitest'
import { WORKER_CONTROL_CHANNEL as PRELOAD_SIDE_CHANNEL } from '../../channels.js'

const ipcOn = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { on: ipcOn } }))

const { forgetWorkerControl, installWorkerControlReports, isControlledByWorker, noteWorkerControl, takeWorkerControlReport } = await import('../worker-control.js')

const URL_A = 'https://kept.eth/'

describe('whether a worker controls a page\'s document', () => {
  it('is the address the page reported, whatever fragment the commit shows', () => {
    const page = {}
    noteWorkerControl(page, URL_A)
    expect(isControlledByWorker(page, URL_A)).toBe(true)
    expect(isControlledByWorker(page, `${URL_A}#top`)).toBe(true)
  })

  it('is never another page\'s, or another address\'s', () => {
    const page = {}
    noteWorkerControl(page, URL_A)
    expect(isControlledByWorker({}, URL_A)).toBe(false)
    expect(isControlledByWorker(page, 'https://kept.eth/other.html')).toBe(false)
    expect(isControlledByWorker(page, 'https://other.eth/')).toBe(false)
  })

  it('is forgotten when a navigation starts, and is nothing for an address that cannot be read', () => {
    const page = {}
    noteWorkerControl(page, URL_A)
    forgetWorkerControl(page)
    expect(isControlledByWorker(page, URL_A)).toBe(false)
    noteWorkerControl(page, 'not an address')
    expect(isControlledByWorker(page, 'not an address')).toBe(false)
  })
})

describe('the report a tab\'s top frame sends', () => {
  const frame = {}
  const sender = { mainFrame: frame } as never

  it('is kept when it comes from the top frame of the tab, with an address', () => {
    takeWorkerControlReport(sender, frame, { documentUrl: URL_A })
    expect(isControlledByWorker(sender, URL_A)).toBe(true)
  })

  it('is dropped from any other frame: a subframe has no preload that sends it', () => {
    const other = { mainFrame: {} } as never
    takeWorkerControlReport(other, {}, { documentUrl: URL_A })
    takeWorkerControlReport(other, null, { documentUrl: URL_A })
    takeWorkerControlReport(other, undefined, { documentUrl: URL_A })
    expect(isControlledByWorker(other, URL_A)).toBe(false)
  })

  it('is dropped when it is not an object holding an address: the renderer is not trusted to send the shape', () => {
    const tab = { mainFrame: frame } as never
    for (const payload of [undefined, null, 'https://kept.eth/', 7, {}, { documentUrl: 7 }, { documentUrl: null }]) takeWorkerControlReport(tab, frame, payload)
    expect(isControlledByWorker(tab, URL_A)).toBe(false)
  })

  it('is listened for on the channel the preload sends it on', () => {
    installWorkerControlReports()
    expect(ipcOn).toHaveBeenCalledWith(PRELOAD_SIDE_CHANNEL, expect.any(Function))
  })
})
