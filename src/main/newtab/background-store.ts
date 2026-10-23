// The new tab's picture for one profile: the copy of the file the person chose, in `<userData>/new-tab-background`,
// and what the page is to show given the `appearance.newTabBackground` setting. The path the person picked is never kept.
// Every read and write of a picture (up to 20 MB) is asynchronous, one at a time.
import { constants } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { checkPicture, MAX_PICTURE_BYTES, TOO_LARGE } from './background-image.js'

export type BackgroundSettings = Pick<SettingsStore, 'get' | 'set' | 'onChange' | 'fileUnreadable'>

/** What a new-tab page draws: the Orivon picture, the plain colour, or these bytes. */
export type PageBackground =
  | { readonly kind: 'orivon' }
  | { readonly kind: 'none' }
  | { readonly kind: 'custom', readonly mime: string, readonly bytes: Uint8Array }

export type InstallResult = { readonly ok: true } | { readonly ok: false, readonly reason: string }

type Picture = { readonly ok: true, readonly mime: string, readonly bytes: Uint8Array } | { readonly ok: false, readonly reason: string }

const KEY = 'appearance.newTabBackground'
const UNREADABLE = 'That file could not be read.'
/** Not defined on Windows, where opening a file never waits for a writer. */
const NON_BLOCKING = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0

/**
 * The checked bytes of the regular file at `path`: never more than the cap is read, and a file that is not a plain file
 * (a pipe that would never answer, a device, a folder) is refused.
 */
async function readPicture (path: string): Promise<Picture> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // Opened without waiting (a pipe with no writer would never answer), and only then looked at: what is checked is the file that was opened.
    // A link to a picture is a picture; open follows it.
    handle = await open(path, constants.O_RDONLY | NON_BLOCKING)
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, reason: UNREADABLE }
    if (info.size > MAX_PICTURE_BYTES) return { ok: false, reason: TOO_LARGE }
    // A file that reports no size (some pseudo-files) has nothing to check, and is never read to its end.
    const buffer = Buffer.allocUnsafeSlow(info.size)
    let total = 0
    while (total < info.size) {
      const { bytesRead } = await handle.read(buffer, total, info.size - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    // Exactly the file's bytes in a buffer of their own: a view into a larger one would send all of it over IPC.
    const bytes = total === info.size ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : Uint8Array.from(buffer.subarray(0, total))
    const checked = checkPicture(bytes)
    return checked.ok ? { ok: true, mime: checked.mime, bytes } : checked
  } catch {
    return { ok: false, reason: UNREADABLE }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class BackgroundStore {
  private readonly listeners = new Set<() => void>()
  /** The checked copy as the page is answered with it: every open new tab asks again after a change, and a picture can be 20 MB. */
  private copy: Promise<PageBackground> | undefined
  /** Installs and removals run one after another, so a removal never takes a picture that was installed after it was asked for. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor (private readonly filePath: string, private readonly settings: BackgroundSettings) {
    // The copy exists only while the setting asks for it, however the setting came to change (a choice, Reset, Reset all).
    settings.onChange(({ key, value }) => {
      if (key !== KEY) return
      if (value !== 'custom') {
        this.copy = undefined
        this.enqueue(async () => { await this.removeCopy() }).catch(() => undefined)
      }
      this.announce()
    })
  }

  /** Tells `listener` after every change to what the page should draw. */
  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Once the settings are read: a copy left behind by a run that ended between writing it and saving the setting goes.
   * Nothing is removed when the settings file could not be read, since the setting then says nothing about the person's choice.
   */
  async reconcile (): Promise<void> {
    if (this.settings.fileUnreadable() || this.settings.get(KEY) === 'custom') return
    await this.enqueue(async () => { await this.removeCopy() })
  }

  /** Copies the file at `sourcePath` (chosen in a dialog, never named by a page) in as the picture, and switches the setting to it. A refused file leaves everything as it was. */
  async install (sourcePath: string): Promise<InstallResult> {
    return await this.enqueue(async () => {
      const picture = await readPicture(sourcePath)
      if (!picture.ok) return picture
      try {
        await writeFileAtomicAsync(this.filePath, picture.bytes)
      } catch {
        return { ok: false, reason: 'Orivon could not save a copy of that picture.' }
      }
      this.copy = Promise.resolve({ kind: 'custom', mime: picture.mime, bytes: picture.bytes })
      if (this.settings.get(KEY) === 'custom') {
        this.announce()
      } else if (!this.settings.set(KEY, 'custom').ok) {
        this.copy = undefined
        await this.removeCopy()
        return { ok: false, reason: 'The new tab background cannot be changed here.' }
      }
      return { ok: true }
    })
  }

  /** A checked copy of a picture is held for this profile, whatever the setting says. */
  async hasUsableCopy (): Promise<boolean> {
    return (await this.load()).kind === 'custom'
  }

  /** What a new tab draws now. A choice of the person's own picture with no usable copy behind it is the Orivon one. */
  async current (): Promise<PageBackground> {
    const chosen = this.settings.get(KEY)
    if (chosen === 'none') return { kind: 'none' }
    if (chosen !== 'custom') return { kind: 'orivon' }
    return await this.load()
  }

  private async load (): Promise<PageBackground> {
    if (this.copy === undefined) {
      const loading = readPicture(this.filePath).then((picture): PageBackground => picture.ok ? { kind: 'custom', mime: picture.mime, bytes: picture.bytes } : { kind: 'orivon' })
      this.copy = loading
      // A copy that could not be read is looked for again next time, not remembered.
      loading.then((read) => { if (read.kind !== 'custom' && this.copy === loading) this.copy = undefined }).catch(() => undefined)
    }
    return await this.copy
  }

  private async enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return await run
  }

  private async removeCopy (): Promise<void> {
    try {
      await rm(this.filePath, { force: true })
    } catch (error) {
      console.warn('[orivon] could not remove the new-tab picture:', error)
    }
  }

  private announce (): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[orivon] a listener of the new-tab picture failed:', error)
      }
    }
  }
}
