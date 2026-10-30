// The address copies wired to the real clipboard.
import { clipboard, ClipboardItem } from 'electron'
import { addressClip, addressesClip } from './address-clipboard.js'
import type { AddressClip } from './address-clipboard.js'

const blob = (text: string, type: string): Blob => new Blob([text], { type })

/** Plain text goes through `writeText`, as it always did; a clip with a link is one item holding both formats, so a
 * program that pastes formatted text finds the link and every other finds the text. The main-process writes return
 * nothing, so they are called plainly: a `.catch` on the result throws. */
export function writeClip (clip: AddressClip): void {
  if (clip.html === undefined) clipboard.writeText(clip.text)
  else clipboard.write([new ClipboardItem({ 'text/plain': blob(clip.text, 'text/plain'), 'text/html': blob(clip.html, 'text/html') })])
}

/** What every address copy of the shell calls: the address as text, with its web link where there is one. */
export function copyAddress (address: string): void {
  writeClip(addressClip(address))
}

export function copyAddresses (addresses: readonly string[]): void {
  writeClip(addressesClip(addresses))
}
