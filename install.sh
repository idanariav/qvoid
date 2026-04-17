#!/usr/bin/env bash
# One-shot installer. Creates a project-local venv, installs qvoid and its
# dependencies, and drops a launcher at ~/.local/bin/qvoid.
#
# Re-run this any time to upgrade in-place.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$PROJECT_DIR/.venv"
BIN_DIR="${QVOID_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/qvoid"

if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 not found on PATH" >&2
    exit 1
fi

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_MAJOR="${PY_VERSION%%.*}"
PY_MINOR="${PY_VERSION#*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
    echo "error: qvoid requires Python 3.11+, found $PY_VERSION" >&2
    exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi

echo "Installing qvoid and dependencies (this may take a minute — torch is ~200MB)"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -e "$PROJECT_DIR"

mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec "$VENV_DIR/bin/qvoid" "\$@"
EOF
chmod +x "$LAUNCHER"

echo ""
echo "qvoid installed → $LAUNCHER"
if ! command -v qvoid >/dev/null 2>&1; then
    echo ""
    echo "Note: $BIN_DIR is not on your PATH. Add this to your shell rc:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
fi
echo ""
echo "Next steps:"
echo "    qvoid init --name <name> --path <vault-path>"
echo "    qvoid index"
