#!/usr/bin/env bash
# brain-attic installer: git clone (or pull) into ~/.local/share/brain-attic and link ~/.local/bin/attic.
#   curl -fsSL https://raw.githubusercontent.com/challengekim/brain-attic/main/install.sh | bash
# Overrides: BRAIN_ATTIC_HOME (install dir), BRAIN_ATTIC_REPO (git URL or local path), BRAIN_ATTIC_BIN_DIR.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "root 권한으로 실행하지 마세요. 사용자 계정으로 실행하면 됩니다." >&2
  exit 1
fi

REPO="${BRAIN_ATTIC_REPO:-https://github.com/challengekim/brain-attic.git}"
DEST="${BRAIN_ATTIC_HOME:-$HOME/.local/share/brain-attic}"
BIN_DIR="${BRAIN_ATTIC_BIN_DIR:-$HOME/.local/bin}"

command -v git >/dev/null 2>&1 || { echo "git 이 필요합니다." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node 20 이상이 필요합니다 (https://nodejs.org)." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node 20 이상이 필요합니다 (현재 $(node -v))." >&2
  exit 1
fi

# Never clobber a ~/.local/bin/attic that is not ours: only a symlink that points into $DEST may be refreshed.
LINK="$BIN_DIR/attic"
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  LINK_OK=0
  if [ -L "$LINK" ]; then
    LINK_TARGET="$(readlink "$LINK")"
    case "$LINK_TARGET" in /*) ;; *) LINK_TARGET="$BIN_DIR/$LINK_TARGET" ;; esac
    case "$LINK_TARGET" in "$DEST"/*) LINK_OK=1 ;; esac
  fi
  if [ "$LINK_OK" != "1" ]; then
    echo "$LINK 가 이미 있고 brain-attic($DEST)을 가리키지 않아 덮어쓰지 않습니다." >&2
    echo "다른 위치를 BRAIN_ATTIC_BIN_DIR 로 지정하거나, 그 파일을 직접 옮긴 뒤 다시 실행하세요." >&2
    exit 1
  fi
fi

if [ -d "$DEST/.git" ]; then
  echo "업데이트: $DEST"
  git -C "$DEST" pull --ff-only
else
  if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    echo "$DEST 가 비어 있지 않고 git 리포도 아닙니다. 다른 위치를 BRAIN_ATTIC_HOME 으로 지정하세요." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DEST")"
  echo "설치: $REPO -> $DEST"
  git clone --depth 1 "$REPO" "$DEST"
fi

chmod +x "$DEST/bin/attic.mjs"
mkdir -p "$BIN_DIR"
ln -sfn "$DEST/bin/attic.mjs" "$LINK"
echo "링크: $LINK"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "안내: $BIN_DIR 가 PATH 에 없습니다. 셸 설정에 추가하세요:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

"$BIN_DIR/attic" doctor || true
echo "다음: attic init --vault ~/notes"
