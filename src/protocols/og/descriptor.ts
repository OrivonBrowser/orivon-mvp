import { describeProtocol } from '../protocol.js'

// Like `.eth`, a name is shown as its plain origin until this install has learned which network its content is on
// (README.md), and its loading screen names no network because it shows before the name has been looked up.
/** `.og` names, each its own origin: `https://<name>.og`. */
export const OG = describeProtocol({
  id: 'og',
  schemes: [],
  topLevelDomains: ['og'],
  loadingScreen: { title: 'Loading', detail: 'Every answer is checked against what it is named by before it is shown.' }
})
