#!/usr/bin/env bash
# Install the applets from this repo into ~/.local/share/cinnamon/applets.
#   ./install.sh                 copy every applet
#   ./install.sh --link          symlink instead (edits in the repo apply after a reload)
#   ./install.sh [--link] UUID…  only the given applets
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/cinnamon/applets"

LINK=false
uuids=()
for arg in "$@"; do
    case "$arg" in
        --link) LINK=true ;;
        -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) uuids+=("${arg%/}") ;;
    esac
done
if (( ${#uuids[@]} == 0 )); then
    for dir in "$REPO"/*@*/; do
        uuids+=("$(basename "$dir")")
    done
fi

mkdir -p "$DEST"
for uuid in "${uuids[@]}"; do
    src="$REPO/$uuid/files/$uuid"
    if [[ ! -d "$src" ]]; then
        echo "Unknown applet: $uuid" >&2
        exit 1
    fi
    rm -rf "${DEST:?}/$uuid"
    if $LINK; then
        ln -s "$src" "$DEST/$uuid"
        echo "Linked    $uuid"
    else
        cp -a "$src" "$DEST/$uuid"
        echo "Installed $uuid"
    fi
done

echo
echo "Add them from the panel: right-click → Applets, or run: cinnamon-settings applets"
echo "Already on the panel? Right-click the applet → Reload, or restart Cinnamon (Ctrl+Alt+Esc)."
