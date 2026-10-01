import { MIN_WINDOW_WIDTH } from '../../side-panel/side-panel-model.js'
import { onPanelChange, sidePanelFor } from '../../side-panel/side-panel-host.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether this window's side panel is open and on which side: the toolbar button's pressed state. */
export const sidePanelStatePart: ShellStatePart = {
  name: 'sidePanel',
  read: ({ window }) => {
    const panel = sidePanelFor(window)
    return { sidePanel: { open: panel.isOpen(), side: panel.side(), minWindow: MIN_WINDOW_WIDTH } }
  },
  watch: ({ window, services }, push) => {
    const stopSetting = services.settings.onChange(({ key }) => { if (key === 'sidePanel.side') push() })
    const stopPanel = onPanelChange(window, push)
    return () => { stopSetting(); stopPanel() }
  }
}
