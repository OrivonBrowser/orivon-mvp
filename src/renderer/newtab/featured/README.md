# `featured/`: the apps under "Orivon Featured", and their icons

**`featured.json`** lists the entries the build ships. Each is `{ id, name, url, icon, pinned, order }`:
`id` a lowercase slug that is also the name label of `url` (`ipfs://<id>.orivonstack.eth`), `icon` a file in this folder
(`null` draws the first letter of `name`), `pinned` an entry shown before the others, and `order` the place among
the pinned entries, then among the rest. A person's own choices (hidden, unpinned, and the app a new profile was given first)
are kept per profile by [`src/main/newtab/`](../../../main/newtab/README.md).

An entry may carry `"hold": { "reason": "..." }`, set by hand while the port lags a security or funds fix of
the app it ports. `src/renderer/newtab/tests/featured-model.test.ts` fails while any entry has one, so the entry
leaves the file (or the port catches up and the `hold` is deleted) before the change can merge. The test checks the
flag, not the port's version: nothing here reads a port's version.


Each icon names the app it belongs to and is shown for nothing else; the marks belong to their owners.

| File | Source |
|---|---|
| `explore.svg` | Orivon Explore's own icon (`apps/explore/site/icon.svg` in orivon-ports) |
| `thelounge.png` | `https://github.com/thelounge/thelounge/blob/14590bfda615b3f3ee0ee8301a404d79a8076743/client/public/img/logo-transparent-bg.svg` |
| `asgardex.png` | `https://github.com/asgardex/asgardex-desktop/blob/bc7b037d9875e6cfb1721bea577a16f72e1e02ea/resources/icon.png` |
| `webtorrent.png` | `https://github.com/webtorrent/webtorrent-desktop/blob/6c91af345d4bd62603d7063ea02a50394d64af0d/static/WebTorrent.png`, drawn as a 96 px opaque tile |
| `ledgerwallet.png` | `https://github.com/LedgerHQ/ledger-live/blob/abed962b08ca4b746f20192b28ce5b6c06a6c6a4/apps/ledger-live-desktop/build/icons/icon@256x256.png`, drawn as a 96 px opaque tile |
