import type { Row, Section } from '../model.js'
import type { SettingsState } from '../state.js'
import type { SettingKey } from '../../../../main/settings/schema.js'
import { copyFor } from '../sites/sites-copy.js'
import type { SitesPart } from '../sites/sites-part.js'
import { renderSitesList } from '../sites/sites-view.js'

/** Built once the state has loaded: which kinds there are is main's table to say, and each gets a row for its default. */
export function sitesSection (state: SettingsState): Section {
  const part = state.part<SitesPart>('sites')
  const defaults: Row[] = part.defaults.map((row) => {
    const copy = copyFor(row)
    return {
      id: `sites-${row.kind}`,
      label: row.label,
      help: copy.help,
      keywords: copy.keywords,
      group: copy.group,
      // The key is main's: the schema is the only place that names it.
      control: { type: 'choice', key: row.settingKey as SettingKey, options: row.options }
    }
  })
  const permissions = defaults.filter((row) => row.group === 'Permissions')
  const content = defaults.filter((row) => row.group === 'Content')
  return {
    id: 'sites',
    title: 'Site settings',
    rows: [
      ...permissions,
      ...content,
      {
        id: 'sites-list',
        label: 'Sites with their own settings',
        help: 'Choices you made for one site, from its address bar or when it asked. Open a site to change them, or reset it to ask again.',
        keywords: ['site', 'sites', 'exceptions', 'allowed', 'blocked', 'permissions', 'per site', 'reset', 'forget'],
        group: 'Sites',
        control: { type: 'custom', wide: true, render: renderSitesList }
      }
    ]
  }
}
