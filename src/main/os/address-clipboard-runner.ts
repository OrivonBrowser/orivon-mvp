// The address copies wired to the real clipboard.
import { clipboard, ClipboardItem } from 'electron'
import { addressClip, addressesClip } from './address-clipboard.js'
import type { AddressClip } from './address-clipboard.js'

const blob = (text: string, type: string): Blob => new Blob([text], { type })

/** Plain text goes through `writeText`; a clip with a link is one item holding both formats, so a program that pastes
 * formatted text finds the link and every other finds the text. Both writes are awaited and a throw becomes a rejection,
 * so a failed write reaches the caller: an unhandled rejection ends the browser, and a copy nobody waits for goes
 * through `copyAddressLogged`. */
export async function writeClip (clip: AddressClip): Promise<void> {
  if (clip.html === undefined) await clipboard.writeText(clip.text)
  else await clipboard.write([new ClipboardItem({ 'text/plain': blob(clip.text, 'text/plain'), 'text/html': blob(clip.html, 'text/html') })])
}

/** What every address copy of the shell calls: the address as text, with its web link where there is one. */
export async function copyAddress (address: string): Promise<void> {
  await writeClip(addressClip(address))
}

export async function copyAddresses (addresses: readonly string[]): Promise<void> {
  await writeClip(addressesClip(addresses))
}

/** A copy nobody waits for, from a menu or a page: a failure is logged and goes no further. */
function logFailure (copy: Promise<void>): void {
  copy.catch((error: unknown) => { console.error('[os] could not copy the address', error) })
}

export function copyAddressLogged (address: string): void {
  logFailure(copyAddress(address))
}

export function copyAddressesLogged (addresses: readonly string[]): void {
  logFailure(copyAddresses(addresses))
}
