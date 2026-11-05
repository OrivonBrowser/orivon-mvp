import type { Row } from '../../model.js'
import type { GraphicsPart } from '../../graphics-part.js'
import { RESTART_HELP, restartHelp } from '../../restart-help.js'
import type { SettingsState } from '../../state.js'

const GROUP = 'Graphics'
const KEY = 'graphics.webgpuOnX11'

const HELP = 'Turns on WebGPU for games and apps that need it. Choosing Grant WebGPU when a site asks turns this on too; setting a site to Allow in Settings or from the address bar does not. It may use more battery, and on some laptops videos can go blank. Read when Orivon starts.'
const REVERTED = 'Orivon turned this off because graphics stopped working while it was on.'

const graphics = (state: SettingsState): GraphicsPart => state.part<GraphicsPart>('graphics')
const offered = (state: SettingsState): boolean => graphics(state).offered

/** Rows spread into Performance, so a feature adds its rows here and edits no other file. They exist only where Orivon runs on an X11 session. */
export const graphicsRows: readonly Row[] = [
  {
    id: 'webgpu-on-x11',
    group: GROUP,
    label: 'Use the graphics card for WebGPU on X11',
    help: HELP,
    helpFor: (state) => graphics(state).revert === null || state.value(KEY) === true ? HELP : `${HELP} ${REVERTED}`,
    keywords: ['webgpu', 'gpu', 'graphics', 'vulkan', 'x11', 'xorg', 'linux', 'games', 'local models', 'battery', 'video', 'hardware'],
    control: { type: 'toggle', key: KEY, locked: (state) => state.profiles?.isPrivate === true },
    visible: offered
  },
  {
    id: 'webgpu-on-x11-restart',
    group: GROUP,
    label: 'Start again to apply',
    help: RESTART_HELP,
    helpFor: restartHelp,
    keywords: ['restart', 'relaunch', 'apply', 'webgpu', 'graphics'],
    control: {
      type: 'action',
      label: 'Restart Orivon',
      run: async (state) => { await state.request('app', { type: 'relaunch' }) }
    },
    visible: (state) => offered(state) && state.isChangedSinceStart(KEY) && state.profiles?.isPrivate !== true
  }
]
