#!/usr/bin/env bash
# Re-embed all documents across all banks by replacing each with itself.
# Triggers the embedding pipeline without changing content.

set -euo pipefail

DRY_RUN=false
VERBOSE=false
ONE_BY_ONE=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --verbose) VERBOSE=true ;;
    --one-by-one) ONE_BY_ONE=true ;;
  esac
done

log() { echo "[$(date +%H:%M:%S)] $*"; }
debug() { $VERBOSE && echo "  >> $*" || true; }

BANKS=$(hindsight bank list -o json 2>/dev/null | jq -r '.[].bank_id')

if [[ -z "$BANKS" ]]; then
  echo "No banks found. Check hindsight API connectivity."
  exit 1
fi

BANK_COUNT=$(echo "$BANKS" | wc -l | tr -d ' ')
log "Found $BANK_COUNT bank(s)"

TOTAL_DOCS=0
TOTAL_OK=0
TOTAL_FAIL=0

for BANK_ID in $BANKS; do
  log "Bank: $BANK_ID"

  # Paginate in case there are many docs
  OFFSET=0
  LIMIT=100

  while true; do
    PAGE=$(hindsight document list "$BANK_ID" -o json \
      --limit "$LIMIT" --offset "$OFFSET" 2>/dev/null)

    DOC_IDS=$(echo "$PAGE" | jq -r '.items[].id // empty' 2>/dev/null || true)

    if [[ -z "$DOC_IDS" ]]; then
      debug "No (more) documents at offset $OFFSET"
      break
    fi

    DOC_COUNT=$(echo "$DOC_IDS" | wc -l | tr -d ' ')
    debug "Processing $DOC_COUNT doc(s) at offset $OFFSET"

    for DOC_ID in $DOC_IDS; do
      TOTAL_DOCS=$((TOTAL_DOCS + 1))

      if $ONE_BY_ONE; then
        DOC_META=$(echo "$PAGE" | jq -r ".items[] | select(.id == \"$DOC_ID\") | \"  id:      \(.id)\\n  chars:   \(.text_length)\\n  units:   \(.memory_unit_count)\\n  context: \(.retain_params.context // \"(none)\")\"")
        echo ""
        echo "────────────────────────────────────────"
        echo "Next document:"
        echo "$DOC_META"
        echo "────────────────────────────────────────"
        printf "  [Enter]=proceed  [s]=skip  [q]=quit  > "
        read -r REPLY </dev/tty
        case "$REPLY" in
          s|S) log "  SKIP $DOC_ID (user)"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); continue ;;
          q|Q) echo ""; log "Quit. total=$TOTAL_DOCS ok=$TOTAL_OK fail=$TOTAL_FAIL"; exit 0 ;;
        esac
      fi
      debug "  doc: $DOC_ID"

      DOC_JSON=$(hindsight document get "$BANK_ID" "$DOC_ID" -o json 2>/dev/null)

      CONTENT=$(echo "$DOC_JSON" | jq -r '.original_text // empty')
      CONTEXT=$(echo "$DOC_JSON" | jq -r '.retain_params.context // empty')

      if [[ -z "$CONTENT" ]]; then
        log "  SKIP $DOC_ID (no original_text)"
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        continue
      fi

      if $DRY_RUN; then
        log "  DRY-RUN: would re-retain $DOC_ID (${#CONTENT} chars)"
        TOTAL_OK=$((TOTAL_OK + 1))
        continue
      fi

      RETAIN_ARGS=(memory retain "$BANK_ID" "$CONTENT" --doc-id "$DOC_ID" --async)
      if [[ -n "$CONTEXT" ]]; then
        RETAIN_ARGS+=(--context "$CONTEXT")
      fi

      if hindsight "${RETAIN_ARGS[@]}" -o json > /dev/null 2>&1; then
        log "  OK  $DOC_ID"
        TOTAL_OK=$((TOTAL_OK + 1))
      else
        log "  FAIL $DOC_ID"
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
      fi
    done

    # If we got fewer than LIMIT, we're done
    if [[ "$DOC_COUNT" -lt "$LIMIT" ]]; then
      break
    fi
    OFFSET=$((OFFSET + LIMIT))
  done
done

echo ""
log "Done. total=$TOTAL_DOCS ok=$TOTAL_OK fail=$TOTAL_FAIL"
