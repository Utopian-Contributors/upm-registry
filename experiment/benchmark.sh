#!/bin/bash
set -euo pipefail

BUN="$HOME/.bun/bin/bun"
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=4873
CSV="$DIR/results.csv"
VERBOSE=0

# Parse flags
args=()
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]}"

if [ $# -eq 0 ]; then
  echo "Usage: benchmark.sh [-v|--verbose] <package-name> [package-name ...]"
  exit 1
fi

log() {
  if [ "$VERBOSE" -eq 1 ]; then
    echo "  [debug] $*"
  fi
}

# Write CSV header if file doesn't exist
if [ ! -f "$CSV" ]; then
  echo "package,original_bytes,stripped_bytes,reduction_pct" > "$CSV"
fi

start_proxy() {
  local stripped="${1:-0}"
  log "Starting proxy (STRIPPED=$stripped)..."
  STRIPPED="$stripped" "$BUN" "$DIR/proxy.mjs" > "$DIR/.proxy.log" 2>&1 &
  PROXY_PID=$!
  # Wait for proxy to be ready
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
      log "Proxy ready (pid=$PROXY_PID)"
      return
    fi
    sleep 0.1
  done
  echo "  [error] Proxy failed to start. Log:"
  cat "$DIR/.proxy.log"
  exit 1
}

stop_proxy() {
  kill -INT "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
  log "Proxy stopped"
  if [ "$VERBOSE" -eq 1 ]; then
    echo "  [debug] Proxy log tail:"
    tail -5 "$DIR/.proxy.log" | sed 's/^/    /'
  fi
}

get_total_bytes() {
  grep 'TOTAL_BYTES_SERVED=' "$DIR/.proxy.log" | tail -1 | sed 's/.*TOTAL_BYTES_SERVED=//'
}

clean_install() {
  rm -rf "$DIR/node_modules" "$DIR/bun.lock"
  cd "$DIR" && "$BUN" pm cache rm > /dev/null 2>&1
}

for pkg in "$@"; do
  echo "=== Benchmarking: $pkg ==="
  echo ""

  # --- Phase 1: Record original responses ---
  echo "Phase 1: Recording original metadata..."
  clean_install
  echo "{\"dependencies\":{\"$pkg\":\"latest\"}}" > "$DIR/package.json"

  start_proxy 0
  log "Running bun install (recording)..."
  if [ "$VERBOSE" -eq 1 ]; then
    cd "$DIR" && "$BUN" install 2>&1 | sed 's/^/    /'
  else
    cd "$DIR" && "$BUN" install > "$DIR/.install.log" 2>&1 || {
      echo "  [error] bun install failed. Output:"
      cat "$DIR/.install.log"
      stop_proxy
      exit 1
    }
  fi
  stop_proxy

  ORIGINAL_BYTES=$(get_total_bytes)
  echo "  Original metadata: $ORIGINAL_BYTES bytes"

  # Save lockfile for comparison
  cp "$DIR/bun.lock" "$DIR/.bun.lock.original"

  # --- Phase 2: Strip responses ---
  echo "Phase 2: Stripping metadata..."
  log "Running strip.mjs..."
  if [ "$VERBOSE" -eq 1 ]; then
    "$BUN" "$DIR/strip.mjs" 2>&1 | sed 's/^/    /'
  else
    "$BUN" "$DIR/strip.mjs" > /dev/null 2>&1
  fi

  # --- Phase 3: Install with stripped responses ---
  echo "Phase 3: Installing with stripped metadata..."
  clean_install

  start_proxy 1
  log "Running bun install (stripped)..."
  if [ "$VERBOSE" -eq 1 ]; then
    cd "$DIR" && "$BUN" install 2>&1 | sed 's/^/    /'
  else
    cd "$DIR" && "$BUN" install > "$DIR/.install.log" 2>&1 || {
      echo "  [error] bun install (stripped) failed. Output:"
      cat "$DIR/.install.log"
      stop_proxy
      exit 1
    }
  fi
  stop_proxy

  STRIPPED_BYTES=$(get_total_bytes)
  echo "  Stripped metadata: $STRIPPED_BYTES bytes"

  # --- Phase 4: Verify lockfiles match ---
  if diff -q "$DIR/.bun.lock.original" "$DIR/bun.lock" > /dev/null 2>&1; then
    echo "  Lockfile: MATCH"
  else
    echo "  Lockfile: MISMATCH"
    diff "$DIR/.bun.lock.original" "$DIR/bun.lock" | head -20
    exit 1
  fi

  # --- Results ---
  if [ "$ORIGINAL_BYTES" -gt 0 ] 2>/dev/null; then
    REDUCTION=$(echo "scale=1; (1 - $STRIPPED_BYTES / $ORIGINAL_BYTES) * 100" | bc)
  else
    REDUCTION="0.0"
  fi

  echo ""
  echo "  Results for $pkg:"
  echo "    Original:  $ORIGINAL_BYTES bytes ($(echo "$ORIGINAL_BYTES / 1024" | bc) KB)"
  echo "    Stripped:  $STRIPPED_BYTES bytes ($(echo "$STRIPPED_BYTES / 1024" | bc) KB)"
  echo "    Reduction: ${REDUCTION}%"
  echo ""

  # Append to CSV
  echo "$pkg,$ORIGINAL_BYTES,$STRIPPED_BYTES,$REDUCTION" >> "$CSV"
  echo "  → Appended to $CSV"
  echo ""
done
