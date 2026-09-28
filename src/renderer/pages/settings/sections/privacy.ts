import type { Section } from '../model.js'

export const privacy: Section = {
  id: 'privacy',
  title: 'Privacy and data',
  rows: [
    {
      id: 'history-remember',
      label: 'Remember the pages I visit',
      help: 'Kept on this computer only, so you can find a page again. Turning it off does not delete what is already there.',
      keywords: ['history', 'browsing', 'record', 'visited', 'remember'],
      control: { type: 'toggle', key: 'history.remember' }
    },
    {
      id: 'history-retention',
      label: 'Keep history for',
      help: 'Pages older than this are removed each time Orivon starts and when you change it.',
      keywords: ['history', 'delete', 'automatically', 'days', 'expire', 'retention'],
      control: { type: 'choice', key: 'history.retentionDays' }
    },
    {
      id: 'history-problem',
      label: 'History is not being kept',
      help: 'The history file could not be opened, so nothing is remembered until this is fixed. The file has not been changed or removed.',
      keywords: ['history', 'error', 'broken', 'corrupt'],
      control: { type: 'info', text: (state) => state.privacy.status?.history.problem ?? '' },
      visible: (state) => state.privacy.status?.history.problem != null
    },
    {
      id: 'history-open',
      label: 'History',
      help: 'Search the pages you have visited, or remove one.',
      keywords: ['history', 'visited', 'search', 'delete', 'remove'],
      control: { type: 'action', label: 'Open history', run: async (state) => { await state.openPage('history') } }
    },
    {
      id: 'usage-statistics',
      label: 'Usage statistics',
      help: 'How long Orivon is open and in use, counted by the month and by app. Nothing else: no address, no page, no search. This is the exact text, and you can change your mind at any time.',
      keywords: ['telemetry', 'analytics', 'statistics', 'usage', 'send', 'report', 'measure', 'consent'],
      control: { type: 'usage' }
    },
    {
      id: 'clear-data',
      label: 'Clear browsing data',
      help: 'Choose what to forget. Bookmarks, permissions you gave and the files apps saved are not touched.',
      keywords: ['clear', 'delete', 'cookies', 'cache', 'site data', 'history', 'zoom', 'wipe', 'forget', 'erase'],
      control: { type: 'clearData' }
    }
  ]
}
