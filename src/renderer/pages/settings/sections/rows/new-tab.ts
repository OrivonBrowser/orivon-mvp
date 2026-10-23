import { h } from '../../../shared/dom.js'
import type { NewTabPart } from '../../new-tab-part.js'
import type { Row } from '../../model.js'
import type { SettingsState } from '../../state.js'

const part = (state: SettingsState): NewTabPart => state.part<NewTabPart>('newTab')

/** Rows spread into the New tab group of Appearance. */
export const newTabRows: readonly Row[] = [
  {
    id: 'new-tab-background',
    label: 'New tab background',
    help: 'The picture behind the search box and tiles on a new tab. Your own picture is copied into this profile.',
    keywords: ['wallpaper', 'background', 'picture', 'image', 'photo', 'new tab', 'home', 'dashboard', 'custom'],
    group: 'New tab',
    below: (state) => part(state).problem === '' ? null : h('p', { className: 'problem', role: 'alert', textContent: part(state).problem }),
    control: {
      type: 'choice',
      key: 'appearance.newTabBackground',
      // Choosing the person's own picture asks for the file first: the setting changes only once a picture is in.
      intercept: async (value, state) => {
        if (value !== 'custom') return false
        await part(state).choose()
        return true
      }
    }
  },
  {
    id: 'new-tab-background-choose',
    label: 'Your picture',
    help: 'Choose another picture: a PNG, JPEG, WebP, GIF or AVIF image of up to 20 MB.',
    keywords: ['wallpaper', 'background', 'picture', 'image', 'photo', 'new tab', 'change', 'choose'],
    group: 'New tab',
    visible: (state) => state.value('appearance.newTabBackground') === 'custom',
    control: { type: 'action', label: 'Choose picture…', run: async (state) => { await part(state).choose() } }
  }
]
