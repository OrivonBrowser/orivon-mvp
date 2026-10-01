import type { Row } from '../../model.js'
import { hostListControl } from '../../controls/host-list.js'
import { renderPowerBadge } from '../../controls/power-badge.js'

/** Rows spread into Performance, so a feature adds its rows here and edits no other file. */
export const memoryRows: readonly Row[] = [
  {
    id: 'memory-saver',
    label: 'Memory saver',
    help: 'Tabs you have not used for a while go to sleep. They wake when you open them.',
    keywords: ['memory', 'sleep', 'discard', 'suspend', 'tabs', 'battery', 'performance', 'ram', 'idle', 'unload'],
    control: { type: 'toggle', key: 'performance.memorySaver' }
  },
  {
    id: 'sleep-after',
    label: 'Put tabs to sleep after',
    keywords: ['memory', 'sleep', 'discard', 'suspend', 'tabs', 'minutes', 'hours', 'idle', 'delay'],
    control: { type: 'choice', key: 'performance.sleepAfter' },
    visible: (state) => state.value('performance.memorySaver') === true
  },
  {
    id: 'keep-awake',
    label: 'Always keep these sites awake',
    help: 'Sites you add here, and their subdomains, never go to sleep. Pinned tabs, tabs playing sound and tabs with unsaved changes stay awake too.',
    keywords: ['memory', 'sleep', 'discard', 'suspend', 'tabs', 'exceptions', 'never', 'keep', 'sites'],
    control: hostListControl('performance.keepAwake', { placeholder: 'Add a site, like example.com', empty: 'Sites you add here never go to sleep.', label: 'Add a site to keep awake' })
  },
  {
    id: 'energy-saver',
    group: 'Energy',
    label: 'Energy saver',
    help: 'On battery, tabs go to sleep after 5 minutes.',
    keywords: ['battery', 'energy', 'power', 'sleep', 'tabs', 'laptop', 'performance', 'save'],
    control: {
      type: 'choice',
      key: 'performance.energySaver',
      options: [{ value: 'off', label: 'Off' }, { value: 'battery', label: 'When on battery' }]
    }
  },
  {
    id: 'power-source',
    label: 'Power source',
    keywords: ['battery', 'power', 'plugged', 'charging'],
    control: { type: 'custom', render: () => renderPowerBadge() }
  }
]
