import type { Section } from '../model.js'

export const web3: Section = {
  id: 'web3',
  title: 'Web3',
  rows: [
    {
      id: 'web3-score-provider',
      label: 'Web3 Score provider',
      help: 'Where Orivon reads judged Web3 Score levels, such as whether a site\'s code is open source. Any address Orivon opens works: https://, ipfs:// or a .eth name. Orivon asks for a group of scores named by the start of a hash, so the provider learns the group, never the site. Empty asks nobody.',
      keywords: ['web3 score', 'score', 'provider', 'trustlessity', 'judged', 'level', 'privacy'],
      control: { type: 'text', key: 'web3.scoreProvider', placeholder: 'None', problem: 'Enter an address, like https://example.com/score' }
    },
    {
      id: 'web3-light-client',
      label: 'Verify .eth names on this computer',
      help: 'A light client proves what a .eth name points to before its page loads, so nobody has to be trusted to say. Turn it off and no .eth name loads. It is read when Orivon starts.',
      keywords: ['ethereum', 'ens', 'eth', 'light client', 'helios', 'verify', 'names', 'ipfs'],
      control: { type: 'toggle', key: 'web3.lightClient', disabled: (state) => state.web3.status?.forcedOff === true }
    },
    {
      id: 'web3-restart',
      label: 'Start again to apply',
      help: 'The choice above is read when Orivon starts. Your tabs and windows are not restored.',
      keywords: ['restart', 'relaunch', 'apply'],
      control: {
        type: 'action',
        label: 'Restart Orivon',
        run: async (state) => { await state.web3.relaunch() }
      },
      visible: (state) => state.web3.needsRestart(state.value('web3.lightClient') === true) && state.profiles?.isPrivate !== true && state.web3.status?.forcedOff !== true
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
      id: 'web3-state',
      label: 'The light client',
      keywords: ['status', 'syncing', 'synced', 'state'],
      control: { type: 'info', text: (state) => state.web3.status === null ? '' : state.web3.status.view.summary }
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
