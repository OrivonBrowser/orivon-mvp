import type { Section } from '../model.js'
import { sidePanelRows } from './rows/side-panel.js'
import { toolbarRows } from './rows/toolbar.js'

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
      id: 'extensions-button',
      label: 'Extensions button',
      help: 'The puzzle piece beside the menu button, which lists your extensions and runs the ones that are not on the toolbar.',
      keywords: ['extensions', 'addons', 'plugins', 'puzzle', 'toolbar', 'button', 'show', 'hide'],
      control: {
        type: 'choice',
        key: 'toolbar.extensions',
        options: [
          { value: 'auto', label: 'Only when I have extensions' },
          { value: 'always', label: 'Always show it' },
          { value: 'never', label: 'Never show it' }
        ]
      }
    },
    {
      id: 'default-zoom',
      label: 'Page zoom',
      help: 'How large websites are shown, unless you have zoomed a site yourself.',
      // macOS zooms with Command and has no Ctrl-and-wheel zoom.
      helpFor: (state) => `How large websites are shown, unless you have zoomed a site yourself. ${state.about?.platform === 'darwin'
        ? 'Zoom a site with ⌘+ and ⌘-.'
        : 'Zoom a site with Ctrl and the mouse wheel, or Ctrl + and Ctrl -.'}`,
      keywords: ['zoom', 'size', 'text', 'larger', 'smaller', 'magnify', 'scale', 'wheel', 'ctrl', 'command'],
      control: { type: 'choice', key: 'appearance.defaultZoom' }
    },
    {
      id: 'downloads-button',
      label: 'Downloads button',
      help: 'The button on the toolbar that shows how far your downloads are and lists them.',
      keywords: ['download', 'toolbar', 'button', 'icon', 'show', 'hide', 'progress', 'shelf'],
      group: 'Toolbar',
      control: {
        type: 'choice',
        key: 'toolbar.downloads',
        options: [
          { value: 'auto', label: 'When there are downloads' },
          { value: 'always', label: 'Always' },
          { value: 'never', label: 'Never' }
        ]
      }
    },
    ...sidePanelRows,
    ...toolbarRows
  ]
}
