import { describeProtocol } from '../protocol.js'

/** `bzz://<reference>`: Swarm content, named by the address of its root chunk. */
export const SWARM = describeProtocol({
  id: 'swarm',
  schemes: ['bzz'],
  topLevelDomains: [],
  loadingScreen: { title: 'Loading from Swarm', detail: 'Every chunk is checked against its content address before it is shown.' }
})
