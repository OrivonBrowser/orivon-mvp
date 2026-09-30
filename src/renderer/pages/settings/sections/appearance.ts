import type { Section } from '../model.js'
import { accentRows } from './rows/accent.js'
import { sidePanelRows } from './rows/side-panel.js'
import { toolbarRows } from './rows/toolbar.js'
import { uiScaleRows } from './rows/ui-scale.js'

export const appearance: Section = {
  id: 'appearance',
  title: 'Appearance',
  rows: [
    {
      id: 'theme',
      label: 'Theme',
      help: 'The browser, its pages and the websites you visit are offered the same choice.',
      keywords: ['dark', 'light', 'colour', 'color', 'mode', 'night'],
      control: {
        type: 'choice',
        key: 'appearance.theme',
        options: [
          { value: 'system', label: 'Match my system' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' }
        ]
      }
    },
    ...accentRows,
    {
      id: 'bookmarks-bar',
      label: 'Bookmarks bar',
      help: 'The row of your bookmarks under the address bar.',
      keywords: ['favourites', 'favorites', 'toolbar', 'show', 'hide'],
      control: {
        type: 'choice',
        key: 'appearance.bookmarksBar',
        options: [
          { value: 'auto', label: 'Only when I have bookmarks' },
          { value: 'always', label: 'Always show it' },
          { value: 'never', label: 'Never show it' }
        ]
      }
    },
    {
      id: 'default-zoom',
      label: 'Page zoom',
      help: 'How large websites are shown, unless you have zoomed a site yourself. Zoom a site with Ctrl and the mouse wheel, or Ctrl + and Ctrl -.',
      keywords: ['zoom', 'size', 'text', 'larger', 'smaller', 'magnify', 'scale'],
      control: { type: 'choice', key: 'appearance.defaultZoom' }
    },
    ...uiScaleRows,
    ...sidePanelRows,
    ...toolbarRows
  ]
}
