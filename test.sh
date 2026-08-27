export DSH_HOME=/tmp/dsh-test
: "${DEEPSEEK_API_KEY:?请先设置 DEEPSEEK_API_KEY}"

cd /home/miuzel/workspace/personal/dsh-subagent-ui

dsh plugin --profile web remove dsh-subagent-workspace-ui
dsh plugin --profile web add file:.
dsh web --port 8084
