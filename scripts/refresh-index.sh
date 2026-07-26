#!/usr/bin/env bash
set -euo pipefail

# Refresh the full qvoid pipeline: link index, classification, embeddings.
#
# Usage: scripts/refresh-index.sh

qvoid index && qvoid classify && qvoid embed
