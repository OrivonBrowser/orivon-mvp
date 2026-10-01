// The folder downloads are saved to, as main reports it: the settings page holds the path chosen, or an
// empty string for the operating system's own folder, and cannot say where that is.
import type { OrivonInternal } from '../shared/bridge.js'

interface FolderReply {
  readonly folder: string
  readonly custom: boolean
}

export class DownloadsState {
  folder = ''
  custom = false

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  async load (): Promise<void> {
    const reply = await this.bridge.request('downloads', { type: 'folder' }) as FolderReply | undefined
    if (reply === undefined) return
    this.folder = reply.folder
    this.custom = reply.custom
    this.changed()
  }

  /** Reads the folder again when its setting changed. The event is never consumed: the setting's own row still needs it. */
  handle (topic: string, payload: unknown): void {
    if (topic === 'settings.changed' && (payload as { key?: unknown } | null)?.key === 'downloads.folder') void this.load()
  }

  async choose (): Promise<void> {
    await this.bridge.request('downloads', { type: 'chooseFolder' })
  }

  async useDefault (): Promise<void> {
    await this.bridge.request('downloads', { type: 'resetFolder' })
  }
}
