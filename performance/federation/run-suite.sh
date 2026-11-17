#!/usr/bin/env bash
# Run the first instance of every WatDiv template against each layout, strictly one query process at
# a time, appending one JSON line per run to $OUT.
#
#   ENGINE   checkout whose engine runs the queries
#   DATA     a WatDiv generated/ directory (dataset.cottas and queries/)
#   PARTS    the output root of partition.js for that dataset
#   LAYOUTS  space-separated layouts: single, or a directory under $PARTS such as subj2 or pred4;
#            a layout ending in "+nt" uses the .nt file in place of the last COTTAS part
#   LABEL    a name for the engine, recorded with each run
#   TIMEOUT  seconds per query (default 300)
set -u
TIMEOUT=${TIMEOUT:-300}
TEMPLATES=${TEMPLATES:-"L1 L2 L3 L4 L5 S1 S2 S3 S4 S5 S6 S7 F1 F2 F3 F4 F5 C1 C2 C3"}
HERE=$(cd "$(dirname "$0")" && pwd)

sources() {
  local layout=$1 base=${1%+nt}
  if [ "$layout" = single ]; then
    echo "$DATA/dataset.cottas"
    return
  fi
  local files=() count
  count=$(ls "$PARTS/$base"/part[0-9].cottas | wc -l)
  for ((k = 0; k < count; k++)); do
    if [ "$layout" != "$base" ] && [ $k -eq $((count - 1)) ]; then
      files+=("$PARTS/$base/part$k.nt")
    else
      files+=("$PARTS/$base/part$k.cottas")
    fi
  done
  (IFS=,; echo "${files[*]}")
}

for template in $TEMPLATES; do
  for layout in $LAYOUTS; do
    line=$(timeout "$TIMEOUT" node "$HERE/run-query.js" "$ENGINE" "$DATA/queries/$template.txt" 0 \
      "$(sources "$layout")" run 2>/dev/null | tail -1)
    [ -z "$line" ] && line="{\"timeout\":$TIMEOUT}"
    echo "{\"engine\":\"$LABEL\",\"dataset\":\"$(basename "$(dirname "$DATA")")\",\"template\":\"$template\",\"layout\":\"$layout\",\"r\":$line}" >> "$OUT"
  done
done
