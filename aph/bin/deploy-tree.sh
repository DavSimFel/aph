#!/bin/sh
# Deploy a git ref into a detached worktree and build it.
#
# The worktree is always reset to the ref as fetched, so a deployment reflects
# the branch and never the state of anyone's working tree.
#
# Usage: deploy-tree.sh <repo> <prefix> <remote-ref>
set -eu
repo=$1; prefix=$2; ref=$3

git -C "$repo" fetch origin "${ref#origin/}"

if [ -e "$prefix/.git" ]; then
	echo "==> updating $prefix to $ref"
	git -C "$prefix" checkout --detach --force "$ref"
	git -C "$prefix" clean -fd
else
	echo "==> creating $prefix at $ref"
	mkdir -p "$(dirname "$prefix")"
	git -C "$repo" worktree add --detach "$prefix" "$ref"
fi

echo "==> building $prefix"
cd "$prefix"
pnpm install --frozen-lockfile
pnpm run build
echo "==> deployed $ref -> $(git -C "$prefix" rev-parse --short HEAD)"
