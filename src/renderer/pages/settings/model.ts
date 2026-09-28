// What a Settings section is made of. A section is data: rows with a label, a
// help line, keywords for search, and a control. The page renders any of them
// the same way, and search reads the same rows it renders, so the two cannot
// drift apart.
import type { SettingKey } from '../../../main/settings/schema.js'
import type { SettingsState } from './state.js'

export type Control =
  /** A choice among a setting's options. Options default to the schema's own, with its labels. */
  | { readonly type: 'choice', readonly key: SettingKey, readonly options?: ReadonlyArray<{ readonly value: string, readonly label: string }> }
  | { readonly type: 'text', readonly key: SettingKey, readonly placeholder: string }
  | { readonly type: 'toggle', readonly key: SettingKey }
  /** A keyboard shortcut: its keys, and the buttons that change it. */
  | { readonly type: 'shortcut', readonly id: string }
  /** Usage statistics: the choice, the exact text that would be sent, and what has been. */
  | { readonly type: 'usage' }
  /** The apps that hold permissions, each with what it may do and a way to take it back. */
  | { readonly type: 'apps' }
  /** What to forget, and the button that forgets it. */
  | { readonly type: 'clearData' }
  /** A value shown, not changed. */
  | { readonly type: 'info', readonly text: (state: SettingsState) => string }
  /** A button. With `confirm`, the first click arms it and the second does it. */
  | { readonly type: 'action', readonly label: string, readonly confirm?: string, readonly danger?: boolean, readonly run: (state: SettingsState) => Promise<void> }

export interface Row {
  readonly id: string
  readonly label: string
  readonly help?: string
  /** Words a person might search for that the label and help do not use. */
  readonly keywords?: readonly string[]
  readonly control: Control
  /** A heading shown above this row when it is the first of its group. */
  readonly group?: string
  /** Absent means always shown. */
  readonly visible?: (state: SettingsState) => boolean
}

export interface Section {
  readonly id: string
  readonly title: string
  readonly intro?: string
  readonly rows: readonly Row[]
}
