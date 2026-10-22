#!/usr/bin/env bash
# Run in the cPanel account through Terminal or cPanel Cron Jobs.
set -euo pipefail

SOURCE='git@github-hyde:Bububooo3/Hyde.git'
BRANCH='hyde-site'
CACHE="$HOME/.hyde-site-cache"
WEBROOT="$HOME/public_html/ai/hyde"
MARKER='.hyde-deploy-managed'
LOCK="$HOME/.hyde-deploy-lock"

# WEBROOT must be a dedicated directory, not a shared document root.
if [[ "$WEBROOT" == "$HOME" || "$WEBROOT" == "$HOME/public_html" || "$WEBROOT" == '/' ]]; then
  echo 'Unsafe deployment directory.' >&2
  exit 1
fi
if [[ ! -d "$WEBROOT" || ! -f "$WEBROOT/$MARKER" ]]; then
  echo "Refusing deployment: verify $WEBROOT, then create $WEBROOT/$MARKER" >&2
  exit 1
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo 'Deployment already running; skipping.'
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

if [[ ! -d "$CACHE/.git" ]]; then
  git clone --depth 1 --single-branch --branch "$BRANCH" "$SOURCE" "$CACHE"
fi
git -C "$CACHE" fetch --depth 1 origin "$BRANCH"
git -C "$CACHE" reset --hard FETCH_HEAD

test -s "$CACHE/index.html" || { echo 'Built index.html missing; deployment aborted.' >&2; exit 1; }

# Delete obsolete Hyde build files while protecting local hosting config.
rsync -a --delete --delay-updates \
  --exclude='/.git/' \
  --exclude="/$MARKER" \
  --exclude='/.htaccess' \
  "$CACHE/" "$WEBROOT/"

printf 'Deployed Hyde build %s\n' "$(git -C "$CACHE" rev-parse --short HEAD)"
