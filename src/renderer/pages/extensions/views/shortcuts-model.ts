// What the shortcuts view knows besides what it draws: the shape main answers
// with, the words each outcome of recording a key gets, and which row is
// listening. Pure; no DOM.

export interface CommandRow {
  readonly name: string
  readonly description: string
  readonly kind: 'action' | 'side-panel' | 'named'
  readonly keys: readonly string[] | null
  readonly suggestedKeys: readonly string[] | null
  readonly unavailable: string | null
}

export interface ExtensionGroup {
  readonly id: string
  readonly name: string
  readonly iconDataUrl: string | undefined
  readonly commands: readonly CommandRow[]
}

export interface ShortcutsReply {
  readonly platform: string
  /** How many extensions are installed, with or without commands. */
  readonly installed: number
  readonly extensions: readonly ExtensionGroup[]
}

export type Outcome =
  | { readonly status: 'ok' | 'cancelled' }
  | { readonly status: 'invalid', readonly problem: 'needs-modifier' | 'reserved' | 'unsupported' }
  | { readonly status: 'orivon', readonly binding: string, readonly label: string }
  | { readonly status: 'extension', readonly binding: string, readonly holder: { readonly extensionId: string, readonly extensionName: string, readonly name: string, readonly description: string } }

export interface Recorded {
  readonly extensionId: string
  readonly name: string
  readonly keys: readonly string[] | null
  readonly result: Outcome
}

/** What sits under a row after a key was refused: a sentence and, when there is one, what the person can do about it. */
export interface Notice {
  readonly text: string
  readonly action?: { readonly label: string, readonly kind: 'settings' | 'move', readonly binding?: string, readonly small: boolean }
}

export const rowKey = (extensionId: string, name: string): string => `${extensionId}\u0000${name}`

export const joinKeys = (keys: readonly string[]): string => keys.join('+')

export function describeCommand (command: CommandRow): string | null {
  if (command.description !== '') return command.description
  if (command.kind === 'action') return 'Activate the extension'
  return command.kind === 'side-panel' ? 'Open the side panel' : null
}

/** The sentence a refused key gets. `groups` lets the other command be named as the page names it. */
export function noticeFor (recorded: Recorded, groups: readonly ExtensionGroup[], platform: string): Notice | null {
  const { result } = recorded
  switch (result.status) {
    case 'ok':
    case 'cancelled':
      return null
    case 'invalid':
      if (result.problem === 'needs-modifier') return { text: platform === 'darwin' ? 'Include Cmd, Ctrl or Option.' : 'Include Ctrl or Alt.' }
      if (result.problem === 'reserved') return { text: 'Orivon keeps that key for editing.' }
      return { text: 'Extension shortcuts use a letter, a number, a function key, an arrow, Home, End, Page Up, Page Down, Insert, Delete, Space, comma or period.' }
    case 'orivon':
      return {
        text: `"${joinKeys(recorded.keys ?? [])}" is Orivon's shortcut for "${result.label}". Change it in Settings first.`,
        action: { label: 'Open shortcut settings', kind: 'settings', small: false }
      }
    case 'extension': {
      const { holder } = result
      const group = groups.find((candidate) => candidate.id === holder.extensionId)
      const command = group?.commands.find((candidate) => candidate.name === holder.name)
      const what = (command === undefined ? null : describeCommand(command)) ?? holder.name
      return {
        text: `"${joinKeys(recorded.keys ?? [])}" is used by "${group?.name ?? holder.extensionName}": ${what}.`,
        action: { label: 'Use it here instead', kind: 'move', binding: result.binding, small: true }
      }
    }
  }
}
