// What the Downloads page and the Settings page may ask of the downloads: read the list, act on one download
// by its id, and, from Settings only, choose the folder. The requests are data from a document, so every
// field is checked here, and no path ever comes in: a download is named by its id.
import type { WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { DownloadService } from './download-service.js'

/** What the domain needs from the settings and the machine. */
export interface DownloadsHost {
  readonly isPrivate: boolean
  /** The folder in effect. */
  folder: () => string
  /** The person chose a folder of their own. */
  isCustomFolder: () => boolean
  openFolder: () => Promise<void>
  /** Opens the folder picker over the window holding `contents`; false when the person cancels or the choice is refused. */
  chooseFolder: (contents: WebContents) => Promise<boolean>
  resetFolder: () => void
}

interface DownloadsRequest {
  readonly type?: unknown
  readonly id?: unknown
}

const MAX_ID_LENGTH = 64

const BY_ID = {
  pause: (service: DownloadService, id: string) => service.pause(id),
  resume: (service: DownloadService, id: string) => service.resume(id),
  cancel: (service: DownloadService, id: string) => service.cancel(id),
  retry: (service: DownloadService, id: string) => service.retry(id),
  remove: (service: DownloadService, id: string) => service.remove(id),
  showInFolder: (service: DownloadService, id: string) => service.showInFolder(id),
  open: async (service: DownloadService, id: string) => await service.open(id),
  deleteFile: async (service: DownloadService, id: string) => await service.deleteFile(id)
} as const

function isByIdCommand (type: unknown): type is keyof typeof BY_ID {
  return typeof type === 'string' && Object.hasOwn(BY_ID, type)
}

export function downloadsDomain (service: DownloadService, host: DownloadsHost): InternalDomain {
  return {
    pages: ['downloads', 'settings'],
    handle: async (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as DownloadsRequest
      const onSettings = caller.page === 'settings'
      if (onSettings) {
        switch (request.type) {
          case 'folder': return { folder: host.folder(), custom: host.isCustomFolder() }
          case 'chooseFolder': return { ok: await host.chooseFolder(caller.contents) }
          case 'resetFolder': host.resetFolder(); return { ok: true }
          case 'openFolder': await host.openFolder(); return { ok: true }
          default: return undefined
        }
      }
      if (isByIdCommand(request.type)) {
        const { id } = request
        if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) return { ok: false }
        return { ok: await BY_ID[request.type](service, id) }
      }
      switch (request.type) {
        case 'list': return { entries: service.list(), folder: host.folder(), private: host.isPrivate }
        case 'clear': service.clear(); return { ok: true }
        case 'openFolder': await host.openFolder(); return { ok: true }
        default: return undefined
      }
    }
  }
}
