// The words a kind's default row uses beyond its label: one help line and the terms a person might search for. A
// kind with no entry still gets a row, with a line made from its label, so a kind added to main's table is found.
import type { DefaultRow } from './sites-model.js'

const COPY: Readonly<Record<string, { readonly help: string, readonly keywords: readonly string[] }>> = {
  camera: { help: 'Sites can ask to use your camera.', keywords: ['webcam', 'video', 'permission'] },
  microphone: { help: 'Sites can ask to use your microphone.', keywords: ['mic', 'audio', 'recording', 'permission'] },
  location: { help: 'Sites can ask for your location. Orivon has no location service yet, so an allowed site is told the position is unavailable.', keywords: ['geolocation', 'gps', 'position', 'permission'] },
  clipboardRead: { help: 'Sites can ask to read what you copied.', keywords: ['paste', 'copy', 'clipboard', 'permission'] },
  midi: { help: 'Sites can ask to control and reprogram your MIDI devices.', keywords: ['music', 'instrument', 'sysex', 'permission'] },
  idle: { help: 'Sites can ask to know when you are away from the computer.', keywords: ['idle', 'away', 'device use', 'idle detection', 'permission'] },
  windowManagement: { help: 'Sites can ask to place windows across your screens.', keywords: ['multi-screen', 'monitors', 'displays', 'permission'] },
  notifications: { help: 'Sites can ask to show notifications.', keywords: ['alerts', 'push', 'permission'] },
  popups: { help: 'Whether sites can open pop-ups and send you to another page on their own.', keywords: ['popup', 'redirect', 'windows', 'blocker'] },
  javascript: { help: 'Whether sites can run scripts.', keywords: ['script', 'js'] },
  images: { help: 'Whether sites can show pictures.', keywords: ['pictures', 'photos'] },
  sound: { help: 'Whether sites can play sound.', keywords: ['audio', 'mute', 'volume'] },
  autoDownloads: { help: 'Whether a site can start several downloads in a row after the first.', keywords: ['download', 'multiple', 'files'] },
  devices: { help: 'Sites can ask to connect to a USB or HID device you pick.', keywords: ['usb', 'hid', 'hardware', 'permission'] },
  screenShare: { help: 'Sites can ask to see your screen, a window or a tab.', keywords: ['screen sharing', 'capture', 'display', 'permission'] }
}

export interface DefaultCopy {
  readonly help: string
  readonly keywords: readonly string[]
  /** The heading above the row. */
  readonly group: string
}

export function copyFor (row: DefaultRow): DefaultCopy {
  const entry = COPY[row.kind]
  return {
    help: entry?.help ?? `What sites may do with ${row.label.toLowerCase()}.`,
    keywords: ['site', 'sites', 'default', ...(entry?.keywords ?? []), row.label.toLowerCase()],
    group: row.group === 'content' ? 'Content' : 'Permissions'
  }
}
