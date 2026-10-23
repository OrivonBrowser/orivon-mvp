// The new tab's picture for one profile: the copy of the file the person chose, in `<userData>/new-tab-background`,
// and what the page is to show given the `appearance.newTabBackground` setting. The path the person picked is never kept.
import { closeSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { checkPicture, MAX_PICTURE_BYTES, TOO_LARGE } from './background-image.js'

export type BackgroundSettings = Pick<SettingsStore, 'get' | 'set' | 'onChange'>

/** What a new-tab page draws: the Orivon picture, the plain colour, or these bytes. */
export type PageBackground =
  | { readonly kind: 'orivon' }
  | { readonly kind: 'none' }
  | { readonly kind: 'custom', readonly mime: string, readonly bytes: Uint8Array }

export type InstallResult = { readonly ok: true } | { readonly ok: false, readonly reason: string }

const UNREADABLE = 'That file could not be read.'

export class BackgroundStore {
  private readonly listeners = new Set<() => void>()
  /** The checked copy as the page is answered with it: every open new tab asks again after a change, and a picture can be 20 MB. */
  private custom: PageBackground | undefined

  constructor (private readonly filePath: string, private readonly settings: BackgroundSettings) {
    // The copy exists only while the setting asks for it, however the setting came to change (a choice, Reset, Reset all).
    settings.onChange(({ key, value }) => {
      if (key !== 'appearance.newTabBackground') return
      if (value !== 'custom') this.removeCopy()
      this.announce()
    })
  }

  /** Tells `listener` after every change to what the page should draw. */
  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Copies the file at `sourcePath` (chosen in a dialog, never named by a page) in as the picture, and switches the setting to it. A refused file leaves everything as it was. */
  install (sourcePath: string): InstallResult {
    let data: Buffer
    try {
      // One open file for the size and the bytes: a file that changes between a check by name and a read is not the one checked.
      const fd = openSync(sourcePath, 'r')
      try {
        const info = fstatSync(fd)
        if (!info.isFile()) return { ok: false, reason: UNREADABLE }
        if (info.size > MAX_PICTURE_BYTES) return { ok: false, reason: TOO_LARGE }
        data = readFileSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      return { ok: false, reason: UNREADABLE }
    }
    const checked = checkPicture(data)
    if (!checked.ok) return checked
    try {
      writeFileAtomic(this.filePath, data)
    } catch {
      return { ok: false, reason: 'Orivon could not save a copy of that picture.' }
    }
    this.custom = undefined
    if (this.settings.get('appearance.newTabBackground') === 'custom') {
      this.announce()
    } else if (!this.settings.set('appearance.newTabBackground', 'custom').ok) {
      this.removeCopy()
      return { ok: false, reason: 'The new tab background cannot be changed here.' }
    }
    return { ok: true }
  }

  /** What a new tab draws now. A choice of the person's own picture with no usable copy behind it is the Orivon one. */
  current (): PageBackground {
    const chosen = this.settings.get('appearance.newTabBackground')
    if (chosen === 'none') return { kind: 'none' }
    if (chosen !== 'custom') return { kind: 'orivon' }
    if (this.custom !== undefined) return this.custom
    try {
      const data = readFileSync(this.filePath)
      const checked = checkPicture(data)
      // A copy of exactly these bytes: a view over a larger buffer would send the whole buffer over IPC.
      if (checked.ok) this.custom = { kind: 'custom', mime: checked.mime, bytes: Uint8Array.from(data) }
      return this.custom ?? { kind: 'orivon' }
    } catch {
      return { kind: 'orivon' }
    }
  }

  private removeCopy (): void {
    this.custom = undefined
    try {
      rmSync(this.filePath, { force: true })
    } catch (error) {
      console.warn('[orivon] could not remove the new-tab picture:', error)
    }
  }

  private announce (): void {
    for (const listener of this.listeners) listener()
  }
}
