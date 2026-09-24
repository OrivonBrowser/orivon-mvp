// The servers the verifier asks by default, chosen by the ENS and IPFS spike
// (docs/planning/spike-results/ens-ipfs.md). Each is trusted for
// availability only: the light client proves what the RPC and the beacon
// API say, and every block and record from the rest is checked. Every launch
// contacts the first two while the light client runs.

export const DEFAULT_ENDPOINTS = {
  executionRpc: 'https://ethereum-rpc.publicnode.com',
  consensusRpc: 'https://ethereum-beacon-api.publicnode.com',
  gateways: ['https://trustless-gateway.link', 'https://ipfs.orbitor.dev', 'https://ipfs.filebase.io'],
  ipnsNameServices: ['https://name.web3.storage'],
  dnsOverHttps: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
} as const
