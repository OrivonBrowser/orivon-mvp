# `resources/default-profile/`: what a new profile starts with

Read by [`src/main/default-profile/`](../../src/main/default-profile/), which says how it is used.

**`bundled-extensions.json`.** The extensions a new profile installs, pinned to a release asset and its
sha256. `scripts/fetch-bundled-extensions.mjs` downloads each into `extensions/` (git ignores it) and refuses
a file whose digest differs. uBlock Origin 1.75.0 is signed by its developer's release key, so it installs under the
id that key gives, `fkgkibajhfbepljeaefdnfnegdcjomkh`, on every profile (the Chrome Web Store's copy has another id). A newer release is a change to the entry's version, url
and sha256; a profile that already has uBlock Origin keeps the version it has.

**`bookmark-icons/`.** Each bookmark's icon, 96 by 96 pixels, shown only to name the site it belongs to; the
marks belong to their owners.

| File | Source |
|---|---|
| `uniswap.png` | `https://cdn.app.uniswap.org/images/512x512_App_Icon.png` |
| `jamescarnley.png` | the site's `favicon.svg`, `ipfs://bafybeiahrsvfblmcdvurapna2mapbl774utjpfyg6bxe2cqpijxjcpzop4/favicon.svg` |
| `ensinterviews.png` | the site names no icon; the tile drawn for Orivon Explore (`apps/explore/site/icons/ensinterviews.png` in orivon-ports) |
| `web3compass.png` | `https://web3compass.net/48x48.svg`, its embedded image squared and scaled |
| `vitalik.png` | the site's `images/icon.png`, `ipfs://bafybeigqyo555suvqi3scc2izft3mozskktbtkzs2xghoe2rpxetxbbdiq/images/icon.png` |
