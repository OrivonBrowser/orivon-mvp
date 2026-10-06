// The servers the verifier asks by default, chosen by the ENS and IPFS spike
// (docs/planning/spike-results/ens-ipfs.md). Each is trusted for
// availability only: the light client proves what the RPC and the beacon
// API say, and every block and record from the rest is checked. The RPCs and the
// beacon API are contacted only while the light client runs: it starts on demand,
// sleeps after 10 minutes idle, and starts at launch only when its checkpoint is over 7 days old.

export const DEFAULT_ENDPOINTS = {
  // Each answer is proven, so any of these may serve a request; the first is the fastest measured.
  executionRpcs: ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://ethereum-rpc.publicnode.com'],
  consensusRpc: 'https://ethereum-beacon-api.publicnode.com',
  gateways: ['https://trustless-gateway.link', 'https://ipfs.orbitor.dev', 'https://ipfs.filebase.io'],
  ipnsNameServices: ['https://name.web3.storage'],
  dnsOverHttps: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
} as const
