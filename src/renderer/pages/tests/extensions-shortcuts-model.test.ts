import { describe, expect, it } from 'vitest'
import { describeCommand, noticeFor, rowKey } from '../extensions/views/shortcuts-model.js'
import type { CommandRow, ExtensionGroup, Recorded } from '../extensions/views/shortcuts-model.js'

const command = (over: Partial<CommandRow> = {}): CommandRow => ({ name: 'go', description: '', kind: 'named', keys: null, suggestedKeys: null, unavailable: null, ...over })
const groups: ExtensionGroup[] = [
  { id: 'a'.repeat(32), name: 'Alpha', iconDataUrl: undefined, commands: [command({ name: 'mark', description: 'Mark the tab' }), command({ name: 'raw' })] }
]

describe('describeCommand', () => {
  it('uses the manifest\'s description, then the words for the commands that have none', () => {
    expect(describeCommand(command({ description: 'Mark' }))).toBe('Mark')
    expect(describeCommand(command({ name: '_execute_action', kind: 'action' }))).toBe('Activate the extension')
    expect(describeCommand(command({ name: '_execute_side_panel', kind: 'side-panel' }))).toBe('Open the side panel')
    expect(describeCommand(command())).toBeNull()
  })
})

describe('noticeFor', () => {
  const recorded = (result: Recorded['result'], keys: readonly string[] | null = ['Ctrl', 'T']): Recorded => ({ extensionId: 'a'.repeat(32), name: 'go', keys, result })

  it('says nothing for a saved or cancelled key', () => {
    expect(noticeFor(recorded({ status: 'ok' }), groups, 'linux')).toBeNull()
    expect(noticeFor(recorded({ status: 'cancelled' }, null), groups, 'linux')).toBeNull()
  })

  it('asks for a modifier in the platform\'s words', () => {
    const result: Recorded['result'] = { status: 'invalid', problem: 'needs-modifier' }
    expect(noticeFor(recorded(result), groups, 'linux')?.text).toBe('Include Ctrl or Alt.')
    expect(noticeFor(recorded(result), groups, 'darwin')?.text).toBe('Include Cmd, Ctrl or Option.')
  })

  it('names a reserved key and a key no extension may use', () => {
    expect(noticeFor(recorded({ status: 'invalid', problem: 'reserved' }), groups, 'linux')?.text).toBe('Orivon keeps that key for editing.')
    expect(noticeFor(recorded({ status: 'invalid', problem: 'unsupported' }), groups, 'linux')?.text).toMatch(/^Extension shortcuts use /)
  })

  it('names the Orivon command that holds the key and points at Settings', () => {
    const notice = noticeFor(recorded({ status: 'orivon', binding: 'Mod+T', label: 'New tab' }), groups, 'linux')
    expect(notice?.text).toBe(`"Ctrl+T" is Orivon's shortcut for "New tab". Change it in Settings first.`)
    expect(notice?.action).toEqual({ label: 'Open shortcut settings', kind: 'settings', small: false })
  })

  it('names the other extension and its command as the page lists them, and offers the move', () => {
    const notice = noticeFor(recorded({ status: 'extension', binding: 'Alt+Shift+K', holder: { extensionId: 'a'.repeat(32), extensionName: 'raw name', name: 'mark', description: '__MSG_x__' } }, ['Alt', 'Shift', 'K']), groups, 'linux')
    expect(notice?.text).toBe('"Alt+Shift+K" is used by "Alpha": Mark the tab.')
    expect(notice?.action).toEqual({ label: 'Use it here instead', kind: 'move', binding: 'Alt+Shift+K', small: true })
  })

  it('falls back to the command\'s name when it has no description', () => {
    const notice = noticeFor(recorded({ status: 'extension', binding: 'Alt+K', holder: { extensionId: 'a'.repeat(32), extensionName: 'Alpha', name: 'raw', description: '' } }, ['Alt', 'K']), groups, 'linux')
    expect(notice?.text).toBe('"Alt+K" is used by "Alpha": raw.')
  })
})

describe('rowKey', () => {
  it('tells two commands of one name in different extensions apart', () => {
    expect(rowKey('a', 'go')).not.toBe(rowKey('b', 'go'))
    expect(rowKey('a', 'go')).not.toBe(rowKey('ag', 'o'))
  })
})
