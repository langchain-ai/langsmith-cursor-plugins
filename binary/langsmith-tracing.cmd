:; : <<'WINDOWS_BATCH'
@echo off
node "%~dp0..\bundle\guard.js" %*
exit /b %ERRORLEVEL%
WINDOWS_BATCH

set -eu

FAILED_TO_START_CODES="126 127 137"

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
node_hook="$here/../bundle/guard.js"

started() {
  case " $FAILED_TO_START_CODES " in
    *" $1 "*) return 1 ;;
  esac
  return 0
}

preferred=""
alternate=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    preferred="$here/langsmith-cursor-tracing-darwin-arm64"
    alternate="$here/langsmith-cursor-tracing-darwin-x64"
    ;;
  Darwin-x86_64)
    preferred="$here/langsmith-cursor-tracing-darwin-x64"
    ;;
esac

carried=""
for build in "$preferred" "$alternate"; do
  if [ -n "$build" ] && [ -x "$build" ]; then
    carried="yes"
    break
  fi
done

if [ -z "$carried" ]; then
  exec node "$node_hook" "$@"
fi

if ! turn=$(mktemp "${TMPDIR:-/tmp}/langsmith-tracing.XXXXXX" 2>/dev/null); then
  exec node "$node_hook" "$@"
fi
if ! answer=$(mktemp "${TMPDIR:-/tmp}/langsmith-tracing.XXXXXX" 2>/dev/null); then
  rm -f "$turn"
  exec node "$node_hook" "$@"
fi
trap 'rm -f "$turn" "$answer"' EXIT

cat >"$turn"

for build in "$preferred" "$alternate"; do
  if [ -z "$build" ] || [ ! -x "$build" ]; then
    continue
  fi
  code=0
  "$build" "$@" <"$turn" >"$answer" || code=$?
  if started "$code"; then
    cat "$answer"
    exit "$code"
  fi
done

code=0
node "$node_hook" "$@" <"$turn" || code=$?
exit "$code"
