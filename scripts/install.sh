#!/usr/bin/env bash
# Install or update the "semantic" search engine module into a Wiki.js 2.x
# installation. Run it again after every Wiki.js update, because updates
# replace the server/ directory.
#
#   sudo ./scripts/install.sh /opt/wikijs            # copy module, keep Wiki.js running
#   sudo ./scripts/install.sh /opt/wikijs wikijs     # ... and restart the systemd unit "wikijs"
set -euo pipefail

WIKI_DIR="${1:-}"
SERVICE="${2:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../module" && pwd)"

if [ -z "$WIKI_DIR" ] || [ ! -f "$WIKI_DIR/server/core/kernel.js" ]; then
  echo "usage: $0 <wiki.js directory> [systemd service to restart]" >&2
  echo "error: '$WIKI_DIR' does not look like a Wiki.js installation" >&2
  exit 1
fi
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WIKI_DIR/package.json" | head -1)"
case "$VERSION" in
  2.*) ;;
  *) echo "error: Wiki.js $VERSION found, this module supports Wiki.js 2.x only" >&2; exit 1 ;;
esac

DEST="$WIKI_DIR/server/modules/search/semantic"
OWNER="$(stat -c '%U:%G' "$WIKI_DIR/server")"
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
cp -r "$SRC/." "$DEST.new/"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
chown -R "$OWNER" "$DEST"
echo "installed module into $DEST (Wiki.js $VERSION, owner $OWNER)"

if [ -n "$SERVICE" ]; then
  systemctl restart "$SERVICE"
  echo "restarted $SERVICE"
else
  echo "restart Wiki.js to load the new code, then enable it under Administration > Search Engine"
fi
