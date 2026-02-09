#!/bin/sh
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGES_FILE="$DIR/benchmark-packages.txt"
CSV="$DIR/results.csv"

# Start fresh
rm -f "$CSV"

# Read packages, skip blank lines and comments
count=0
while IFS= read -r pkg; do
  case "$pkg" in
    ""|\#*) continue ;;
  esac
  count=$((count + 1))
done < "$PACKAGES_FILE"

echo "Benchmarking $count packages..."
echo ""

while IFS= read -r pkg; do
  case "$pkg" in
    ""|\#*) continue ;;
  esac
  "$DIR/benchmark.sh" "$pkg"
done < "$PACKAGES_FILE"

echo ""
echo "=== Results ==="
column -t -s',' "$CSV"

# Print total
awk -F',' 'NR>1 { orig+=$2; strip+=$3 } END {
  pct = (1 - strip/orig) * 100
  printf "\nTotal: %.1f MB original, %.1f MB stripped, %.1f%% reduction\n", orig/1048576, strip/1048576, pct
}' "$CSV"
