export DSH_HOME="$HOME/tmp/dsh-test"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${1:-8084}"

dsh plugin --profile web remove dsh-subagent-workspace-ui
dsh plugin --profile web add file:.
dsh web --port "$PORT"
