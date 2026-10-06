import { describe, expect, it, vi } from 'vitest'
import { openFileCommand } from '../open-file-command.js'
import type { ShellWindow } from '../window-registry.js'

function target (): { shell: ShellWindow, openLocalFile: ReturnType<typeof vi.fn> } {
  const openLocalFile = vi.fn(() => Promise.resolve('f'))
  const shell = {
    window: {},
    tabs: { openLocalFile, createTab: vi.fn(), getState: () => ({ tabs: [], activeTabId: null }), closeTab: vi.fn(), activeWebContents: () => undefined }
  } as unknown as ShellWindow
  return { shell, openLocalFile }
}

describe('openFileCommand', () => {
  it('opens the file the person picks as a local file, in front', async () => {
    const { shell, openLocalFile } = target()
    const pick = vi.fn(() => Promise.resolve('/home/u/notes/a b.html'))
    await openFileCommand(shell, pick, 'linux')
    expect(openLocalFile).toHaveBeenCalledWith('file:///home/u/notes/a%20b.html', true)
    expect(pick).toHaveBeenCalledOnce()
  })

  it('opens nothing when the dialog is cancelled or answers something that is no absolute path', async () => {
    const { shell, openLocalFile } = target()
    await openFileCommand(shell, () => Promise.resolve(undefined), 'linux')
    await openFileCommand(shell, () => Promise.resolve('relative/a.html'), 'linux')
    expect(openLocalFile).not.toHaveBeenCalled()
  })
})
