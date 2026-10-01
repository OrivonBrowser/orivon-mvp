import type { Row } from '../../model.js'

/** Rows spread into the Side panel group of Appearance, so a feature adds its rows here and edits no other file. */
export const sidePanelRows: readonly Row[] = [
  {
    id: 'side-panel-side',
    label: 'Side panel position',
    help: 'The panel beside the page for bookmarks, history and more. Open it with the side panel button on the toolbar.',
    keywords: ['sidebar', 'panel', 'dock', 'left', 'right', 'bookmarks', 'history'],
    group: 'Side panel',
    control: {
      type: 'choice',
      key: 'sidePanel.side',
      options: [
        { value: 'right', label: 'Right side' },
        { value: 'left', label: 'Left side' }
      ]
    }
  }
]
