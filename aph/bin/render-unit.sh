#!/bin/sh
# Render the systemd unit template for one aph deployment.
#
# Usage: render-unit.sh <template> <out> <description> <node> <nodebin> <noderoot> <code> <state> <workspace> <runtime> <port> <domain>
set -eu
template=$1; out=$2; description=$3; node=$4; nodebin=$5; noderoot=$6
code=$7; state=$8; workspace=$9; shift 9
runtime=$1; port=$2; domain=$3

mkdir -p "$(dirname "$out")"
sed \
	-e "s|@DESCRIPTION@|$description|g" \
	-e "s|@NODEBIN@|$nodebin|g" \
	-e "s|@NODEROOT@|$noderoot|g" \
	-e "s|@NODE@|$node|g" \
	-e "s|@CODE@|$code|g" \
	-e "s|@STATE@|$state|g" \
	-e "s|@WORKSPACE@|$workspace|g" \
	-e "s|@RUNTIME@|$runtime|g" \
	-e "s|@PORT@|$port|g" \
	-e "s|@DOMAIN@|$domain|g" \
	"$template" > "$out"
echo "==> rendered $out"
