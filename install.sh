#!/usr/bin/env bash
# anchor installer. Picks the right binary, drops it in /usr/local/bin.
set -euo pipefail

REPO="f4rkh4d/anchor"
BIN="anchor"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Darwin-arm64)              ASSET="anchor-darwin-arm64" ;;
  Darwin-x86_64)             ASSET="anchor-darwin-x64" ;;
  Linux-x86_64)              ASSET="anchor-linux-x64" ;;
  Linux-aarch64|Linux-arm64) ASSET="anchor-linux-arm64" ;;
  *) echo "unsupported platform: $OS-$ARCH" >&2; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
echo "downloading $ASSET"
TMP="$(mktemp)"
curl -fsSL -o "$TMP" "$URL"
chmod +x "$TMP"

DEST="/usr/local/bin/$BIN"
if [ -w "$(dirname "$DEST")" ]; then
  mv "$TMP" "$DEST"
else
  echo "needs sudo to write $DEST"
  sudo mv "$TMP" "$DEST"
fi

echo "installed: $($BIN version)"
echo
echo "next:"
echo "  anchor proxy &"
echo "  export ANTHROPIC_BASE_URL=http://localhost:7777"
echo "  open Claude Code or Cursor and use as normal"
