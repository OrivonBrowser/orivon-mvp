import type { Section } from '../model.js'

export const web3: Section = {
  id: 'web3',
  title: 'Web3',
  rows: [
    {
      id: 'web3-score-provider',
      label: 'Web3 Score provider',
      help: 'Where Orivon reads judged Web3 Score levels, such as whether a site\'s code is open source. Any address Orivon opens works: https://, ipfs:// or a .eth name. Orivon asks for a group of scores named by the start of a hash, one of at most 256, so the provider learns the group, never the site, though one that scores only a few sites can guess. Unless you change it, Orivon\'s own provider is used; empty asks nobody.',
      keywords: ['web3 score', 'score', 'provider', 'trustlessity', 'judged', 'level', 'privacy'],
      control: { type: 'text', key: 'web3.scoreProvider', placeholder: 'None', problem: 'Enter an address, like https://example.com/score' }
    },
    {
      id: 'web3-light-client',
      label: 'Verify .eth names on this computer',
      help: 'A light client proves what a .eth name points to before its page loads, so nobody has to be trusted to say. Turn it off and no .eth name loads. A change applies at once.',
      keywords: ['ethereum', 'ens', 'eth', 'light client', 'helios', 'verify', 'names', 'ipfs'],
      control: { type: 'toggle', key: 'web3.lightClient', disabled: (state) => state.web3.status?.forcedOff === true }
    },
    {
      id: 'web3-forced-off',
      label: 'Switched off from outside',
      help: 'This run was started with the light client switched off, so the switch above cannot change it. The choice made there applies to a start without that.',
      keywords: ['environment', 'variable'],
      control: { type: 'info', text: () => 'Off for this run' },
      visible: (state) => state.web3.status?.forcedOff === true
    },
    {
      id: 'web3-eth-gateway',
      label: 'Open .eth.limo addresses as .eth names',
      help: 'An address like https://vitalik.eth.limo/ goes through a public gateway, which decides what the page is. Orivon opens vitalik.eth itself instead, checked on this computer, and keeps the rest of the address. This applies to .eth.limo and .eth.link pages opened in a tab and to what any page loads from such an address (images, scripts, requests and frames), and not while the light client is off or cannot start. A .eth name can be framed only by a page of its own name, so a frame of another name stays empty. Sign-ins, wallet connections and data a site keeps under its eth.limo address stay there and are not seen at the .eth name.',
      keywords: ['eth.limo', 'eth.link', 'gateway', 'redirect', 'ens'],
      control: { type: 'toggle', key: 'web3.ethGatewayRedirect' }
    },
    {
      id: 'web3-state',
      label: 'The light client',
      keywords: ['status', 'syncing', 'synced', 'state'],
      control: { type: 'info', text: (state) => state.web3.status === null ? '' : state.web3.status.view.summary }
    },
    {
      id: 'web3-ipfs-source',
      label: 'Load IPFS sites from',
      help: 'Your own IPFS node runs on this computer: it starts when an IPFS address is opened and finds the content on the IPFS network. Public gateways are servers that fetch it for you, so they learn which sites you open. Either way, every block is checked before it is shown. With your own node, a page that the node cannot load says so and offers to load that site through gateways, once; nothing goes to a gateway unless you choose it here or press that button. A change applies at once.',
      keywords: ['ipfs', 'node', 'gateway', 'gateways', 'source', 'privacy', 'ipns'],
      control: { type: 'choice', key: 'web3.ipfsSource' }
    },
    {
      id: 'web3-ipfs-lookup',
      label: 'Use a lookup service to find IPFS sites faster',
      help: 'Your node asks two lookup services, delegated-ipfs.dev and cid.contact, and the IPFS network at the same time, and uses whichever answers first. The services learn which sites you look up; what they find is still checked. Off, only the IPFS network is asked, which can be slower. A change applies at once.',
      keywords: ['ipfs', 'lookup', 'routing', 'delegated', 'privacy', 'dht', 'faster'],
      control: { type: 'toggle', key: 'web3.ipfsLookupService' },
      visible: (state) => state.value('web3.ipfsSource') !== 'gateways'
    },
    {
      id: 'web3-ipfs-node',
      label: 'Your IPFS node',
      keywords: ['ipfs', 'node', 'status'],
      visible: (state) => state.web3.status?.view.ipfsNode !== undefined,
      control: { type: 'info', text: (state) => state.web3.status?.view.ipfsNode?.summary ?? '' }
    },
    {
      id: 'web3-swarm-enabled',
      label: 'Run a Swarm node on this computer',
      help: 'Swarm content loads only from a node Orivon runs here, which starts when a Swarm address is opened. Turn it off and a Swarm address says Swarm is off. A change applies at once.',
      keywords: ['swarm', 'bzz', 'node', 'bee', 'peers', 'network'],
      control: { type: 'toggle', key: 'web3.swarmNode' }
    },
    {
      id: 'web3-swarm-node',
      label: 'The Swarm node',
      help: 'Swarm content loads only from a node Orivon runs on this computer. It starts when a Swarm address is opened.',
      keywords: ['swarm', 'bzz', 'node', 'peers', 'bee'],
      visible: (state) => state.web3.status?.view.swarmNode !== undefined,
      control: { type: 'info', text: (state) => state.web3.status?.view.swarmNode?.summary ?? '' }
    },
    {
      id: 'web3-checkpoint',
      label: 'Where it started from',
      keywords: ['checkpoint', 'trust', 'age'],
      control: { type: 'info', text: (state) => state.web3.status?.view.checkpoint ?? '' }
    },
    {
      id: 'web3-about',
      label: 'What the servers learn',
      keywords: ['privacy', 'servers', 'lookup'],
      control: { type: 'info', text: (state) => state.web3.status?.view.about ?? '' }
    },
    {
      id: 'web3-servers',
      label: 'Servers it asks',
      help: 'Asked while it runs. Their answers are checked before use, except where the text above says otherwise.',
      keywords: ['servers', 'endpoints', 'rpc', 'gateway', 'beacon', 'dns', 'privacy'],
      control: { type: 'info', text: (state) => (state.web3.status?.view.endpoints ?? []).map((group) => `${group.label}: ${group.urls.join(', ')}`).join('\n') }
    }
  ]
}
