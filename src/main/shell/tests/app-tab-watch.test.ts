import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({}))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: () => false }))

const { watchAppTab } = await import('../app-tab-watch.js')
const { APP_TAB_FLAG } = await import('../tab-partition.js')

afterEach(() => { vi.restoreAllMocks() })

function appView (url: string): { emitter: EventEmitter, view: never } {
  const emitter = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => url })
  return { emitter, view: { webContents: emitter } as never }
}

describe('an app tab reporting its failures', () => {
  it('names the page by origin and path, never its query or fragment, which can hold a token', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { emitter, view } = appView('https://app.example/inbox/open?token=s3cret#access_token=also-secret')
    watchAppTab(view, [APP_TAB_FLAG])

    emitter.emit('console-message', { level: 'error', message: 'boom', sourceId: '', lineNumber: 0 })
    emitter.emit('preload-error', {}, '/p.js', new Error('x'))
    emitter.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

    expect(spy).toHaveBeenCalledTimes(3)
    for (const call of spy.mock.calls) {
      const line = String(call[0])
      expect(line).toContain('[orivon][app https://app.example/inbox/open]')
      expect(line).not.toMatch(/s3cret|access_token|\?|#/)
    }
  })

  it('still says where a page with an unparsable address was, without echoing it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { emitter, view } = appView('not a url?token=s3cret')
    watchAppTab(view, [APP_TAB_FLAG])

    emitter.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

    expect(String(spy.mock.calls[0]![0])).not.toContain('s3cret')
  })
})
