#!/bin/sh
# Upload a fresh YouTube cookie export to the home helper. Heroku picks it up
# within 30 minutes, or immediately on the next YouTube verification failure.
# Usage: deploy/home-helper/push-cookies.sh path/to/cookies.txt [user@host]
set -eu
file=${1:?usage: push-cookies.sh cookies.txt [user@host]}
host=${2:-ihsan@192.168.0.5}
dir=.local/share/hararest-home-helper
head -n 1 "$file" | grep -Eq '^# (Netscape )?HTTP Cookie File' || { echo 'not a Netscape cookie file' >&2; exit 1; }
# Write to a temporary name then rename, so the helper never serves a partial file.
scp -q "$file" "$host:$dir/.cookies.txt.new"
ssh "$host" "chmod 600 $dir/.cookies.txt.new && mv $dir/.cookies.txt.new $dir/cookies.txt"
echo 'cookies uploaded'
