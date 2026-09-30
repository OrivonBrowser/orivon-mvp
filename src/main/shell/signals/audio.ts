// A tab's sound: whether the page is making any, and whether the person switched it off. The mute belongs to the
// tab's record, not to a webContents, so it survives the view swap a cross-origin navigation makes.
import type { WebContents } from 'electron'
import type { TabSignal } from '../tab-signals.js'
import type { TabRecord } from '../tab-types.js'

/** Whether this tab's page is to be silent. The one place a rule for muting is decided. */
export function mutedFor (record: TabRecord, _wc: WebContents): boolean {
  return record.muted === true
}

/** Puts the record's mute on the page it shows now. */
export function applyMuted (record: TabRecord): void {
  const wc = record.view.webContents
  if (!wc.isDestroyed()) wc.setAudioMuted(mutedFor(record, wc))
}

export const audioSignal: TabSignal = {
  name: 'audio',
  wire: ({ wc, shown, record }) => {
    // No event follows a mute or an unmute, and `isCurrentlyAudible` stays true while muted: only a change of
    // what the page plays is announced here.
    wc.on('audio-state-changed', () => { if (shown()) record.host.emitState() })
  },
  apply: ({ wc, record }) => { wc.setAudioMuted(mutedFor(record, wc)) },
  state: (record, wc) => ({ muted: record.muted === true, audible: wc?.isCurrentlyAudible() ?? false })
}
