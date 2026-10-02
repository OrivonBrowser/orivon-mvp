import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { DevToolsService } from '../devtools-service.js'
import type { DevToolsDeps } from '../devtools-service.js'

const showConsolePanel = vi.hoisted(() => vi.fn())
vi.mock('../open-console.js', () => ({ showConsolePanel }))

class FakeContents extends EventEmitter {
  opened = false
  destroyed = false
  readonly openDevTools = vi.fn(() => { this.opened = true })
  getURL (): string { return 'https://site.example/' }
  isDestroyed (): boolean { return this.destroyed }
  isDevToolsOpened (): boolean { return this.opened }
}

const as = (contents: FakeContents): WebContents => contents as unknown as WebContents

function setup (deps: Partial<DevToolsDeps> = {}, tools = true): { service: DevToolsService, confirm: ReturnType<typeof vi.fn<(contents: WebContents, label: string) => Promise<boolean>>> } {
  const confirm = vi.fn(async (_contents: WebContents, _label: string) => true)
  const settings = { get: (key: string) => key === 'developer.tools' ? tools : 'right', onChange: () => () => {} }
  return { service: new DevToolsService(settings as never, { appOf: () => null, isShellPage: () => false, developerMode: () => false, confirm, ...deps }), confirm }
}

describe('opening the JavaScript console', () => {
  it('opens the tools when they are closed, then selects the Console panel', async () => {
    showConsolePanel.mockClear()
    const { service } = setup()
    const contents = new FakeContents()
    await service.openConsole(as(contents))
    expect(contents.openDevTools).toHaveBeenCalledOnce()
    expect(showConsolePanel).toHaveBeenCalledWith(contents)
  })

  it('moves tools that are already open to the Console panel without opening a second set', async () => {
    showConsolePanel.mockClear()
    const { service } = setup()
    const contents = new FakeContents()
    contents.opened = true
    await service.openConsole(as(contents))
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(showConsolePanel).toHaveBeenCalledOnce()
  })

  it('does nothing when developer tools are off, as the key does', async () => {
    showConsolePanel.mockClear()
    const { service } = setup({}, false)
    const contents = new FakeContents()
    await service.openConsole(as(contents))
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(showConsolePanel).not.toHaveBeenCalled()
  })

  it('asks the once-only question for an app holding permissions, and stops on No', async () => {
    showConsolePanel.mockClear()
    const { service, confirm } = setup({ appOf: () => ({ key: 'app-1', label: 'app.example' }) })
    confirm.mockResolvedValueOnce(false)
    const contents = new FakeContents()
    await service.openConsole(as(contents))
    expect(confirm).toHaveBeenCalledExactlyOnceWith(contents, 'app.example')
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(showConsolePanel).not.toHaveBeenCalled()
  })

  it('keeps the shell\'s own pages closed to it, and ignores no page or a destroyed one', async () => {
    showConsolePanel.mockClear()
    const { service } = setup({ isShellPage: () => true })
    const shell = new FakeContents()
    await service.openConsole(as(shell))
    await service.openConsole(undefined)
    const gone = new FakeContents()
    gone.destroyed = true
    await service.openConsole(as(gone))
    expect(shell.openDevTools).not.toHaveBeenCalled()
    expect(showConsolePanel).not.toHaveBeenCalled()
  })
})
