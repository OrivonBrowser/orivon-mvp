// The Downloads page: the files this browser has downloaded and is downloading, with pause, resume, cancel,
// retry, open and show in folder. Where files go, and whether to ask, is set in Settings.
import { DownloadsState } from './state.js'
import { DownloadsView } from './view.js'

const state = new DownloadsState()
const view = new DownloadsView(state)
const app = document.getElementById('app')
if (app !== null) view.mount(app)

const { catchUp } = state.listen(() => document.visibilityState === 'visible')
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') catchUp() })
void state.load()
