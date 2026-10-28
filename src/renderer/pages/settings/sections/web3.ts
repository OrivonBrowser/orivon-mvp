import type { Section } from '../model.js'
import { endpointListControl } from '../controls/endpoint-list.js'

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
      help: 'An address like https://vitalik.eth.limo/ goes through a public gateway, which decides what the page is. Orivon opens vitalik.eth itself instead, checked on this computer, and keeps the rest of the address. This applies to .eth.limo and .eth.link pages opened in a tab and to what any page loads from such an address (images, scripts, stylesheets and requests), and not while the light client is off or cannot start. Frames are the one thing that keeps loading through the gateway, because a .eth site refuses to be framed by another site. Sign-ins, wallet connections and data a site keeps under its eth.limo address stay there and are not seen at the .eth name.',
      keywords: ['eth.limo', 'eth.link', 'gateway', 'redirect', 'ens'],
      control: { type: 'toggle', key: 'web3.ethGatewayRedirect' }
    },
    {
      id: 'web3-eth-servers',
      label: 'Ethereum servers',
      help: "Orivon's servers are the public Ethereum servers Orivon asks by default. With your own, yours are asked instead of Orivon's, and Orivon's are not tried when yours fail: a .eth name waits until yours answer again, and the light client's state below says which one broke. Every answer is still checked on this computer, so a server can stop a .eth site from loading but never make one show the wrong site. A server learns the names you open; an address with a key in it ties them to your account there, even through a tunnel. A server on this computer or your home network is reached directly, never through a tunnel. In a private window that runs through Nym, Orivon's servers are always used. A change applies at once.",
      keywords: ['ethereum', 'ens', 'eth', 'rpc', 'node', 'infura', 'alchemy', 'drpc', 'custom', 'own', 'server', 'servers', 'beacon', 'privacy', 'helios', 'light client'],
      control: { type: 'choice', key: 'web3.ethServers', locked: (state) => state.isHeld('web3.ethServers') }
    },
    {
      id: 'web3-eth-rpcs',
      label: 'Your Ethereum servers',
      help: 'Up to four addresses, asked in the order listed. An address on the internet starts with https://, like https://mainnet.infura.io/v3/your-key. For a node on this computer or your home network, type its address, like http://127.0.0.1:8545 or http://192.168.1.20:8545. A key in an address is hidden here, in the logs and in bug reports. Leave the list empty to keep asking Orivon\'s servers.',
      keywords: ['rpc', 'ethereum', 'node', 'infura', 'alchemy', 'drpc', 'custom', 'url', 'address', 'key', 'local', 'dappnode'],
      control: endpointListControl('web3.ethRpcs', { kind: 'execution', max: 4, placeholder: 'Add an address, like https://rpc.example.com/key', empty: "No address added: Orivon's Ethereum servers are asked.", label: 'Add an Ethereum server address', full: 'You can list up to 4 addresses' }),
      visible: (state) => state.value('web3.ethServers') === 'custom'
    },
    {
      id: 'web3-eth-beacon',
      label: 'Your beacon server',
      help: 'Optional. The light client starts from a recent checkpoint, which this server must be able to give. An address has no ? part. Leave it empty to keep asking Orivon\'s beacon server.',
      keywords: ['beacon', 'consensus', 'ethereum', 'node', 'custom', 'url', 'address', 'checkpoint'],
      control: endpointListControl('web3.ethBeacon', { kind: 'beacon', max: 1, placeholder: 'Add an address, like https://beacon.example.com', empty: "No address added: Orivon's beacon server is asked.", label: 'Add a beacon server address', full: 'Remove the address to add another' }),
      visible: (state) => state.value('web3.ethServers') === 'custom'
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
