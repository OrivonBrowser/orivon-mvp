import type { SettingsState } from './state.js'

const READ_AT_START = 'The choice above is read when Orivon starts.'

/** What a restart does to the tabs is decided by the start-up choice the next start reads, so the line follows it. */
export const RESTART_HELP = `${READ_AT_START} Your tabs and windows are not restored.`
export const RESTART_HELP_CONTINUING = `${READ_AT_START} Your tabs and windows open again.`

export function restartHelp (state: SettingsState): string {
  return state.value('startup.mode') === 'continue' ? RESTART_HELP_CONTINUING : RESTART_HELP
}
