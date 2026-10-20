#!/bin/bash
# Fills PKGBUILD for one release, proves it builds, and writes its .SRCINFO. It runs inside an Arch container
# (release.yml, job `aur`), because only Arch has makepkg; the files it leaves are the two to push to the AUR.
#
#   UPSTREAM        the release version as the tag writes it, without the v: 0.0.9, 0.2.0-beta.1
#   SHA256          the sha256 of the release's orivon_<UPSTREAM>_amd64.deb
#   HOST_UID        the uid that owns the directory, so the files it writes stay removable by the runner
#   OLD_UPSTREAM, OLD_PKGREL, OLD_SHA256   what the AUR holds now; all empty for a package it does not hold yet
#
# The directory holds PKGBUILD; this script leaves `result` there: publish, same, older or unmappable.
set -euo pipefail

dir=${1:?usage: prepare.sh <directory holding PKGBUILD>}
cd "$dir"
: "${UPSTREAM:?}" "${SHA256:?}" "${HOST_UID:?}"

# pkgver may not contain a hyphen. A pre-release (-alpha.1, -beta.2, -rc.1) drops it and sorts before the release;
# any other suffix has no mapping that sorts right, so it is left to be released by hand.
if ! [[ $UPSTREAM =~ ^[0-9]+(\.[0-9]+){2}(-[A-Za-z]+(\.[0-9]+)?)?$ ]]; then
  echo "unmappable" > result
  echo "$UPSTREAM has no AUR version that sorts right" >&2
  exit 0
fi
pkgver=${UPSTREAM//-/}

pkgrel=1
if [ -n "${OLD_UPSTREAM:-}" ]; then
  order=$(vercmp "$pkgver" "${OLD_UPSTREAM//-/}")
  if [ "$order" -lt 0 ]; then
    echo "older" > result
    exit 0
  elif [ "$order" -eq 0 ]; then
    if [ "${OLD_SHA256:-}" = "$SHA256" ]; then
      echo "same" > result
      exit 0
    fi
    pkgrel=$((${OLD_PKGREL:-1} + 1))
  fi
fi

sed -i -e "s|^_upstream=.*|_upstream=${UPSTREAM}|" -e "s|^pkgrel=.*|pkgrel=${pkgrel}|" \
  -e "s|^sha256sums=.*|sha256sums=('${SHA256}')|" PKGBUILD
grep -q "^_upstream=${UPSTREAM}\$" PKGBUILD && grep -q "^pkgrel=${pkgrel}\$" PKGBUILD && grep -q "^sha256sums=('${SHA256}')\$" PKGBUILD

# makepkg refuses root. The build happens in a copy so that no source, package or downloaded file is left to be pushed.
id builder >/dev/null 2>&1 || useradd -m -u "$HOST_UID" builder
work=$(mktemp -d)
cp PKGBUILD "$work/"
chown -R builder "$work"
su builder -c "cd '$work' && makepkg --printsrcinfo > .SRCINFO && makepkg --nodeps --noconfirm --force"
cp "$work/.SRCINFO" .SRCINFO
chown "$HOST_UID" PKGBUILD .SRCINFO
echo "publish" > result
