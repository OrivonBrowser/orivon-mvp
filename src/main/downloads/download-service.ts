// The downloads this process has started or remembers. Every download a tab makes arrives at `track`, inside
// Electron's `will-download`, where the file's path has to be chosen before the handler returns: a path set
// later never completes the item (see README.md, Design notes). Everything the page may do to a download
// goes through the ids kept here, so a page never names a path.
import { basename, dirname, join } from 'node:path'
import type { DownloadItem, WebContents } from 'electron'
import { isDangerousFile } from './dangerous-file.js'
import { holdPath, isHoldPath, keepPath, released, restoreEntries, shouldHold } from './danger-hold.js'
import { MAX_ADDRESS_LENGTH, boundedText, isActive, isSettled, safeFileName, storedAddress, summarise, uniquePath } from './download-model.js'
import { MAX_ENTRIES } from './download-store.js'
import type { DownloadStore } from './download-store.js'
import type { DownloadChange, DownloadEntry, DownloadReason, DownloadState, DownloadSummary } from './download-types.js'

/** What the service needs from the machine it runs on. */
export interface DownloadDeps {
  /** The folder files are saved to. */
  folder: () => string
  /** The operating system's own Downloads folder, for when `folder` cannot be made. */
  fallbackFolder: () => string
  askWhere: () => boolean
  fileExists: (path: string) => boolean
  /** Makes the folder when it is missing; false when it cannot be made or written. */
  ensureFolder: (dir: string) => boolean
  /** Whether files can be written into an existing folder. */
  folderWritable: (dir: string) => boolean
  openPath: (path: string) => Promise<string>
  showInFolder: (path: string) => void
  trash: (path: string) => Promise<void>
  /** Renames a file inside one folder. Throws when it cannot. */
  rename: (from: string, to: string) => void
  /** Deletes a file; nothing to delete is not an error. Throws when it cannot. */
  removeFile: (path: string) => void
  /** Asks for `url` again, as a new download. */
  fetchAgain: (url: string) => void
  now: () => number
  newId: () => string
}

export interface StartInfo {
  readonly id: string
  readonly item: DownloadItem
  readonly contents: WebContents | undefined
  readonly userGesture: boolean
}

/** How many downloads one tab may have running before the rest are refused. */
export const MAX_RUNNING_PER_TAB = 10
/** How many downloads a page may start without the person asking for any, in a window of time, before the rest are refused. */
export const MAX_AUTOMATIC_PER_WINDOW = 3
export const AUTOMATIC_WINDOW_MS = 10_000
/** Stands for the tabs a download does not name (one with no tab behind it) in the bookkeeping per tab. */
const NO_TAB = -1
const MISSING_CHECK_MS = 2000
const RETRY_WAIT_MS = 30_000

interface Live {
  readonly item: DownloadItem
  readonly contentsId: number | undefined
  registered: boolean
}

function pageAddress (contents: WebContents | undefined): string {
  try {
    const url = contents === undefined || contents.isDestroyed() ? '' : contents.getURL()
    return /^https?:/iu.test(url) ? url : ''
  } catch {
    return ''
  }
}

export class DownloadService {
  private entries: DownloadEntry[]
  private readonly live = new Map<string, Live>()
  private readonly listeners = new Set<(change: DownloadChange) => void>()
  private readonly startListeners = new Set<(info: StartInfo) => void>()
  /** Tabs whose refused downloads have already been written down once. */
  private readonly flooded = new Set<number>()
  /** When each tab last started a download the person did not ask for, newest last. */
  private readonly automatic = new Map<number, number[]>()
  /** A retry's address to the entry it replaces once the new download starts. */
  private readonly retrying = new Map<string, string>()
  private readonly missingChecks = new Map<string, { at: number, missing: boolean }>()
  /** Downloads running whose save dialog has not been answered: not listed until it is. */
  private readonly unlisted = new Map<string, DownloadEntry>()
  /** Where the last save dialog ended, for the next: kept for this run only. */
  private lastFolder: string | undefined

  constructor (private readonly store: DownloadStore, private readonly deps: DownloadDeps, private readonly maxRunning = MAX_RUNNING_PER_TAB) {
    // Nothing is still running that a previous run left unfinished: the list says so instead of pretending.
    const restored = restoreEntries(store.read(), deps.now(), deps.fileExists)
    this.entries = restored.entries
    for (const leftover of restored.leftovers) this.drive(() => { deps.removeFile(leftover) })
    if (restored.changed) store.write(this.entries)
  }

  list (): DownloadEntry[] {
    return this.entries.map((entry) => this.read(entry))
  }

  summary (): DownloadSummary {
    return summarise(this.entries)
  }

  /** Returns the removal. `null` means the list changed in a way that needs reading again. */
  onChange (listener: (change: DownloadChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Runs after a download's save path is set. A listener may cancel the item. Returns the removal. */
  onStart (listener: (info: StartInfo) => void): () => void {
    this.startListeners.add(listener)
    return () => { this.startListeners.delete(listener) }
  }

  /** Called from `will-download`, synchronously: the save path is decided before this returns. */
  track (item: DownloadItem, contents: WebContents | undefined, event: { preventDefault: () => void }): void {
    const contentsId = contents?.id
    const url = storedAddress(item.getURLChain()[0] ?? item.getURL())
    const referrer = storedAddress(pageAddress(contents))
    const suggested = safeFileName(item.getFilename())
    const mime = boundedText(item.getMimeType())
    if ((contentsId !== undefined && this.runningIn(contentsId) >= this.maxRunning) || this.tooManyAutomatic(contentsId ?? NO_TAB, item.hasUserGesture(), url)) {
      this.refuse(event, { url, referrer, fileName: suggested, mime, contentsId: contentsId ?? NO_TAB })
      return
    }
    const folder = this.usableFolder()
    const id = this.deps.newId()
    const held = shouldHold(suggested, mime, this.deps.askWhere())
    let savePath = ''
    if (this.deps.askWhere()) {
      item.setSaveDialogOptions({ title: 'Save file', defaultPath: join(this.lastFolder ?? folder, suggested) })
    } else {
      savePath = held ? holdPath(folder, id) : uniquePath(folder, suggested, (path) => this.taken(path))
      item.setSavePath(savePath)
    }
    const fileName = savePath === '' || held ? suggested : basename(savePath)
    const entry: DownloadEntry = {
      id, url, referrer, fileName, savePath, mime,
      total: item.getTotalBytes(), received: item.getReceivedBytes(), state: 'progressing',
      startedAt: this.deps.now(), danger: isDangerousFile(fileName, mime), ...(held ? { held: true } : {})
    }
    const live: Live = { item, contentsId, registered: false }
    this.live.set(entry.id, live)
    // With a save dialog the list learns of the download once the person has answered it, and never if they did not.
    if (savePath !== '') this.register(entry, live)
    else this.unlisted.set(entry.id, entry)
    item.on('updated', (_event, state) => { this.updated(entry.id, state) })
    item.once('done', (_event, state) => { this.done(entry.id, state) })
    const info: StartInfo = { id: entry.id, item, contents, userGesture: item.hasUserGesture() }
    for (const listener of [...this.startListeners]) {
      try { listener(info) } catch (error) { console.error('[orivon] a download listener failed:', error) }
    }
  }

  pause (id: string): boolean {
    const live = this.live.get(id)
    if (live === undefined || this.find(id)?.state !== 'progressing') return false
    return this.drive(() => { live.item.pause() }) && this.patch(id, { state: 'paused', speed: 0 })
  }

  resume (id: string): boolean {
    const live = this.live.get(id)
    const state = this.find(id)?.state
    if (live === undefined || (state !== 'paused' && !(state === 'interrupted' && live.item.canResume()))) return false
    return this.drive(() => { live.item.resume() }) && this.patch(id, { state: 'progressing' }, true)
  }

  cancel (id: string): boolean {
    const live = this.live.get(id)
    if (live === undefined || !this.isRunning(id)) return false
    const cancelled = this.drive(() => { live.item.cancel() })
    if (cancelled && this.isRunning(id)) this.patch(id, { state: 'cancelled', speed: 0, endedAt: this.deps.now() })
    return cancelled
  }

  /** Asks for the same address again. A download still held open by an interruption is resumed instead. */
  retry (id: string): boolean {
    const entry = this.find(id)
    if (entry === undefined || !isSettled(entry)) return false
    const live = this.live.get(id)
    if (live !== undefined && entry.state === 'interrupted' && live.item.canResume()) return this.resume(id)
    // An address that was cut to be stored is not the one that was asked for.
    if (!/^https?:\/\//iu.test(entry.url) || entry.url.length >= MAX_ADDRESS_LENGTH) return false
    this.retrying.set(entry.url, id)
    setTimeout(() => { this.retrying.delete(entry.url) }, RETRY_WAIT_MS).unref()
    this.deps.fetchAgain(entry.url)
    return true
  }

  /** Forgets one finished download. The file stays where it is. */
  remove (id: string): boolean {
    const entry = this.find(id)
    if (entry === undefined || !isSettled(entry)) return false
    this.cancelLeftover(id)
    this.drop([id])
    this.emit(null)
    return true
  }

  /** Forgets every download that is not running. No file is touched. */
  clear (): void {
    const ids = this.entries.filter(isSettled).map((entry) => entry.id)
    if (ids.length === 0) return
    for (const id of ids) this.cancelLeftover(id)
    this.drop(ids)
    this.emit(null)
  }

  /** Opens the file with the program the system picks. Refused for a dangerous type, a file that is not finished and one that is gone. */
  async open (id: string): Promise<boolean> {
    const entry = this.find(id)
    if (entry === undefined || entry.state !== 'completed' || entry.danger || !this.deps.fileExists(entry.savePath)) return false
    return await this.deps.openPath(entry.savePath) === ''
  }

  showInFolder (id: string): boolean {
    const entry = this.find(id)
    if (entry === undefined || entry.state !== 'completed' || !this.deps.fileExists(entry.savePath)) return false
    this.deps.showInFolder(entry.savePath)
    return true
  }

  /** Gives a held file its real name; from then on it is an ordinary finished download that Orivon still never opens. */
  keep (id: string): boolean {
    const entry = this.find(id)
    if (entry?.state !== 'held') return false
    if (!this.deps.fileExists(entry.savePath) || !isHoldPath(entry.savePath)) { this.discard(id); return false }
    const target = keepPath(entry, (path) => this.taken(path))
    if (!this.drive(() => { this.deps.rename(entry.savePath, target) })) return false
    return this.patch(id, { state: 'completed', savePath: target, fileName: basename(target), danger: true, held: false })
  }

  /** Deletes a held file and forgets the download. */
  discard (id: string): boolean {
    const entry = this.find(id)
    if (entry?.state !== 'held') return false
    // A path that is not a hold file is never deleted: the entry is only forgotten.
    if (isHoldPath(entry.savePath) && !this.drive(() => { this.deps.removeFile(entry.savePath) })) return false
    this.drop([id])
    this.emit(null)
    return true
  }

  /** Moves the file to the system's trash; the list keeps the row, now marked as gone. */
  async deleteFile (id: string): Promise<boolean> {
    const entry = this.find(id)
    if (entry === undefined || entry.state !== 'completed' || !this.deps.fileExists(entry.savePath)) return false
    try {
      await this.deps.trash(entry.savePath)
    } catch (error) {
      console.error('[orivon] moving a download to the trash failed:', error)
      return false
    }
    this.missingChecks.delete(id)
    this.emit(entry)
    return true
  }

  async flush (): Promise<void> {
    await this.store.flush()
  }

  /** Deletes every temporary file a hold still has on disk. A private session calls this as it ends: its list is not
   * kept, so nothing would ever answer for a file it left. */
  discardHeldFiles (): void {
    for (const entry of [...this.entries, ...this.unlisted.values()]) {
      if (entry.held === true && isHoldPath(entry.savePath)) this.drive(() => { this.deps.removeFile(entry.savePath) })
    }
  }

  private find (id: string): DownloadEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  private isRunning (id: string): boolean {
    const entry = this.find(id) ?? this.unlisted.get(id)
    return entry !== undefined && isActive(entry)
  }

  private runningIn (contentsId: number): number {
    let running = 0
    for (const [id, live] of this.live) {
      if (live.contentsId === contentsId && this.isRunning(id)) running += 1
    }
    return running
  }

  /** Whether this download is one more than a page may start unasked: counted per tab over a short window, and not by a
   * retry the person pressed. A refused download is not counted, so the window drains and the page may start again. */
  private tooManyAutomatic (tab: number, userGesture: boolean, url: string): boolean {
    if (userGesture || this.retrying.has(url)) return false
    const now = this.deps.now()
    const recent = (this.automatic.get(tab) ?? []).filter((at) => now - at < AUTOMATIC_WINDOW_MS)
    if (recent.length >= MAX_AUTOMATIC_PER_WINDOW) { this.automatic.set(tab, recent); return true }
    this.automatic.set(tab, [...recent, now])
    return false
  }

  /** Whether a file could not take this name: it is on disk, or a download in progress is about to put one there. */
  private taken (path: string): boolean {
    return this.deps.fileExists(path) || this.entries.some((entry) => isActive(entry) && entry.savePath === path)
  }

  private usableFolder (): string {
    const preferred = this.deps.folder()
    if (this.deps.ensureFolder(preferred)) return preferred
    const fallback = this.deps.fallbackFolder()
    this.deps.ensureFolder(fallback)
    return fallback
  }

  private drive (action: () => void): boolean {
    try {
      action()
      return true
    } catch (error) {
      console.error('[orivon] a download refused the request:', error)
      return false
    }
  }

  /** A live item the list no longer wants (an interruption the person gave up on). */
  private cancelLeftover (id: string): void {
    const live = this.live.get(id)
    if (live === undefined) return
    this.live.delete(id)
    this.drive(() => { live.item.cancel() })
  }

  private refuse (event: { preventDefault: () => void }, refused: { url: string, referrer: string, fileName: string, mime: string, contentsId: number }): void {
    event.preventDefault()
    if (this.flooded.has(refused.contentsId)) return
    this.flooded.add(refused.contentsId)
    const { contentsId: _tab, ...facts } = refused
    const now = this.deps.now()
    this.register({
      id: this.deps.newId(), ...facts, savePath: '', total: 0, received: 0, state: 'interrupted', reason: 'flood',
      startedAt: now, endedAt: now, danger: isDangerousFile(facts.fileName, facts.mime)
    }, undefined)
  }

  private register (entry: DownloadEntry, live: Live | undefined): void {
    if (live !== undefined) live.registered = true
    this.unlisted.delete(entry.id)
    const replaced = this.retrying.get(entry.url)
    if (replaced !== undefined) {
      this.retrying.delete(entry.url)
      this.drop([replaced])
    }
    this.entries = [entry, ...this.entries]
    const surplus = this.entries.length - MAX_ENTRIES
    if (surplus > 0) this.drop(this.entries.filter(isSettled).slice(-surplus).map((candidate) => candidate.id))
    this.store.write(this.entries)
    this.emit(replaced === undefined ? entry : null)
  }

  private drop (ids: readonly string[]): void {
    const gone = new Set(ids)
    this.entries = this.entries.filter((entry) => !gone.has(entry.id))
    for (const id of ids) this.missingChecks.delete(id)
    this.store.write(this.entries)
  }

  /** Applies `changes` to a listed entry and tells the listeners. False when it is not listed. */
  private patch (id: string, changes: Partial<DownloadEntry>, clearOutcome = false): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id)
    const current = this.entries[index]
    if (current === undefined) return false
    const merged = clearOutcome ? running({ ...current, ...changes }) : { ...current, ...changes }
    const next = merged.held === false ? released(merged) : merged
    this.entries = [...this.entries.slice(0, index), next, ...this.entries.slice(index + 1)]
    if (current.state !== next.state) this.store.write(this.entries)
    this.emit(next)
    return true
  }

  /** What the item knows now: progress, and the name and path when a dialog or another listener chose them. */
  private progress (item: DownloadItem, entry: DownloadEntry): Partial<DownloadEntry> {
    const itemPath = item.getSavePath()
    // Another listener choosing its own path (Save page as) ends the hold: the person named that file.
    const holding = entry.held === true && (itemPath === '' || itemPath === entry.savePath)
    const savePath = itemPath === '' || holding ? entry.savePath : itemPath
    const fileName = holding || savePath === '' ? entry.fileName : basename(savePath)
    const mime = boundedText(item.getMimeType())
    return {
      received: item.getReceivedBytes(), total: item.getTotalBytes(), mime, speed: item.getCurrentBytesPerSecond(),
      savePath, fileName, danger: holding || isDangerousFile(fileName, mime), ...(entry.held === true ? { held: holding } : {})
    }
  }

  private updated (id: string, itemState: 'progressing' | 'interrupted'): void {
    const live = this.live.get(id)
    if (live === undefined) return
    const entry = this.find(id) ?? this.unlisted.get(id)
    if (entry === undefined) return
    const state: DownloadState = itemState === 'interrupted' ? 'interrupted' : live.item.isPaused() ? 'paused' : 'progressing'
    const current: DownloadEntry = { ...entry, ...this.progress(live.item, entry), state }
    const next = state === 'interrupted' ? { ...current, reason: this.reasonFor(current), endedAt: this.deps.now() } : running(current)
    if (!live.registered) {
      if (current.savePath !== '') this.lastFolder = dirname(current.savePath)
      this.register(next, live)
    } else {
      this.patch(id, next, state !== 'interrupted')
    }
  }

  private done (id: string, itemState: 'completed' | 'cancelled' | 'interrupted'): void {
    const live = this.live.get(id)
    if (live === undefined) return
    this.live.delete(id)
    this.flooded.delete(live.contentsId ?? NO_TAB)
    const entry = this.find(id) ?? this.unlisted.get(id)
    if (entry === undefined) return
    const progress = this.progress(live.item, entry)
    const savePath = progress.savePath ?? ''
    // A save dialog the person dismissed ends the item cancelled with no path: they never asked to keep it.
    if (itemState === 'cancelled' && savePath === '') {
      this.unlisted.delete(id)
      if (live.registered) { this.drop([id]); this.emit(null) }
      return
    }
    // A held file that did not arrive whole leaves nothing in the folder.
    if (progress.held === true && itemState !== 'completed') this.drive(() => { this.deps.removeFile(savePath) })
    const finished: DownloadEntry = {
      ...entry, ...progress, state: progress.held === true && itemState === 'completed' ? 'held' : itemState, speed: 0, endedAt: this.deps.now(),
      ...(itemState === 'completed' ? { total: Math.max(progress.total ?? 0, progress.received ?? 0) } : {})
    }
    const base = progress.held === true && itemState !== 'completed' ? { ...finished, held: false } : finished
    const settled = itemState === 'interrupted' ? { ...base, reason: this.reasonFor(finished) } : withoutReason(base)
    if (!live.registered) this.register(settled, live)
    else this.patch(id, settled)
  }

  /** Chromium says only that a download broke. Nothing written and a folder that cannot be written means the disk; nothing received, the server. */
  private reasonFor (entry: DownloadEntry): DownloadReason {
    if (entry.savePath !== '' && !this.deps.folderWritable(dirname(entry.savePath))) return 'disk'
    return entry.received === 0 ? 'server' : 'network'
  }

  private read (entry: DownloadEntry): DownloadEntry {
    return entry.state === 'completed' && this.isMissing(entry) ? { ...entry, missing: true } : entry
  }

  private isMissing (entry: DownloadEntry): boolean {
    const now = this.deps.now()
    const cached = this.missingChecks.get(entry.id)
    if (cached !== undefined && now - cached.at < MISSING_CHECK_MS) return cached.missing
    const missing = !this.deps.fileExists(entry.savePath)
    this.missingChecks.set(entry.id, { at: now, missing })
    return missing
  }

  private emit (change: DownloadChange): void {
    const sent = change === null ? null : this.read(change)
    for (const listener of [...this.listeners]) {
      try { listener(sent) } catch (error) { console.error('[orivon] a download listener failed:', error) }
    }
  }
}

/** A download that runs again has no stop to report. */
function running (entry: DownloadEntry): DownloadEntry {
  const { reason: _reason, endedAt: _endedAt, ...rest } = entry
  return rest
}

function withoutReason (entry: DownloadEntry): DownloadEntry {
  const { reason: _reason, ...rest } = entry
  return rest
}
