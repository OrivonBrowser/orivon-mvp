# `packaging/`

What the release workflow hands to the places people install Orivon from, other than the files `electron-builder`
writes. [`docs/development/packaging.md`](../docs/development/packaging.md) says how each is used and what the owner sets up once.

- `aur/`: the `orivon-bin` package for the Arch User Repository: `PKGBUILD` is the template, `prepare.sh` fills it from a
  release inside an Arch container.
- `appimagehub/`: the one file AppImageHub's listing needs.
- `release-routes.json`: which of the Store, winget and the AUR the release notes point to, `true` once the route works.

**What it may depend on.** Nothing in `src/`. **What must never go in:** a secret; every credential is a repository secret
read by `.github/workflows/release.yml`.
