#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

OSS_BUCKET="${OSS_BUCKET:-touchworld-website}"
OSSUTIL_BIN="${OSSUTIL_BIN:-ossutil}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/tmp/npm-cache-codex}"
RUN_TYPECHECK="${RUN_TYPECHECK:-1}"
RUN_BUILD="${RUN_BUILD:-1}"
DELETE_REMOTE="${DELETE_REMOTE:-1}"

NODE24=(npx --cache "$NPM_CACHE_DIR" -p node@24 node)
NPM24=(npx --cache "$NPM_CACHE_DIR" -p node@24 -p npm@11 npm)

if [[ ! -f package.json ]]; then
  echo "package.json not found. Run this script from the website repository."
  exit 1
fi

if ! command -v "$OSSUTIL_BIN" >/dev/null 2>&1; then
  cat <<'EOF'
ossutil is not installed or is not available in PATH.

Install Alibaba Cloud ossutil, then configure it once with:
  ossutil config

Use this endpoint for the Shenzhen bucket:
  https://oss-cn-shenzhen.aliyuncs.com

Do not store the AccessKey ID or AccessKey Secret in this repository.
EOF
  exit 1
fi

if [[ ! -x node_modules/.bin/next ]]; then
  echo "Next.js dependencies not found. Installing with Node 24..."
  "${NPM24[@]}" ci --include=optional --cache "$NPM_CACHE_DIR"
fi

echo "Repository: $ROOT_DIR"
echo "OSS bucket: oss://$OSS_BUCKET/"

if [[ "$RUN_TYPECHECK" == "1" ]]; then
  echo "Running typecheck with Node 24..."
  NEXT_PUBLIC_BASE_PATH="" "${NPM24[@]}" run typecheck
fi

if [[ "$RUN_BUILD" == "1" ]]; then
  echo "Building the root-path static export with Node 24..."
  NEXT_PUBLIC_BASE_PATH="" "${NODE24[@]}" node_modules/next/dist/bin/next build
fi

if [[ ! -f out/index.html || ! -f out/404.html ]]; then
  echo "Static export is incomplete: out/index.html or out/404.html is missing."
  exit 1
fi

if grep -q '/TouchWorld-website' out/index.html; then
  echo "The export still contains the GitHub Pages base path. Aborting OSS upload."
  exit 1
fi

SYNC_ARGS=(sync "$ROOT_DIR/out/" "oss://${OSS_BUCKET}/" --force)
if [[ "$DELETE_REMOTE" == "1" ]]; then
  SYNC_ARGS+=(--delete)
fi

echo "Synchronizing out/ to OSS..."
"$OSSUTIL_BIN" "${SYNC_ARGS[@]}"

echo "OSS deployment completed."
echo "Website: https://touchworld.phanes-ai.com/"
echo "If CDN HTML caching is enabled, the homepage may take a few minutes to refresh."
