// What a Settings section is made of. A section is data: rows with a label, a
// help line, keywords for search, and a control. The page renders any of them
// the same way, and search reads the same rows it renders, so the two cannot
// drift apart.
import type { SettingKey } from '../../../main/settings/schema.js'
import type { SettingsState } from './state.js'

export type Control =
  /** A choice among a setting's options. Options default to the schema's own, with its labels. */
  | { readonly type: 'choice', readonly key: SettingKey, readonly options?: ReadonlyArray<{ readonly value: string, readonly label: string }> }
  /** `problem` is what the row says when main refuses the value; without it, the search address's own message. */
  | { readonly type: 'text', readonly key: SettingKey, readonly placeholder: string, readonly problem?: string }
  /** `disabled` greys the switch out when the setting cannot take effect, and the row's help says why. */
  | { readonly type: 'toggle', readonly key: SettingKey, readonly disabled?: (state: SettingsState) => boolean }
  /** A list of web addresses kept as the newline-separated text of a setting, with a way to add, remove and take the open pages. */
  | { readonly type: 'pageList', readonly key: SettingKey }
  /** The search engines with their keywords, and the form that adds, edits and removes the person's own. */
  | { readonly type: 'engines' }
  /** A keyboard shortcut: its keys, and the buttons that change it. */
  | { readonly type: 'shortcut', readonly id: string }
  /** Usage statistics: the choice, the exact text that would be sent, and what has been. */
  | { readonly type: 'usage' }
  /** The apps that hold permissions, each with what it may do and a way to take it back. */
  | { readonly type: 'apps' }
  /** What to forget, and the button that forgets it. */
  | { readonly type: 'clearData' }
  /** A control a feature draws itself; `wide` stacks it under its label at full width. It reads what it shows from `state` and acts through `state.request` or a part of `state.part`. */
  | { readonly type: 'custom', readonly wide?: boolean, readonly render: (state: SettingsState) => HTMLElement }
  /** A value shown, not changed. */
  | { readonly type: 'info', readonly text: (state: SettingsState) => string }
  /** A button. With `confirm`, the first click arms it and the second does it. With `shows`, a value is shown before it. */
  | { readonly type: 'action', readonly label: string, readonly confirm?: string, readonly danger?: boolean, readonly shows?: (state: SettingsState) => string, readonly run: (state: SettingsState) => Promise<void> }

export interface Row {
  readonly id: string
  readonly label: string
  readonly help?: string
  /** The help line when it depends on a value, in place of `help`. */
  readonly helpFor?: (state: SettingsState) => string
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
