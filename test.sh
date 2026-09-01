#!/usr/bin/env bash
# dsh-subagent-workspace-ui smoke runner —— 环境相关冒烟脚本，非单测。
#
# 用法：
#   ./test.sh [PORT]                          # 本地 dsh（默认版本）跑 web，端口 ${PORT:-8084}
#   DSH_VERSION=0.1.1-rc.2 ./test.sh [PORT]   # 用 pnpx 拉取指定 dsh 版本跑 web
#
# 说明：
#   - DSH_HOME 固定为 $HOME/tmp/dsh-test（独立测试目录，不影响日常 profile）。
#   - DSH_VERSION 非空时，用 `pnpx @deepseek-ai/dsh@<version>` 运行；默认经
#     `proxychains4 -q` 走代理拉取并运行（可用 DSH_PROXY 覆盖，例如 DSH_PROXY="" 表示直连）。
#   - remove/add 与 web 都走同一个 `$DSH`，保证 profile 由目标 dsh 版本管理（幂等重跑安全）。

export DSH_HOME="$HOME/tmp/dsh-test"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${1:-8084}"
DSH_VERSION="${DSH_VERSION:-}"
PROXY_PREFIX="${DSH_PROXY:-proxychains4 -q}"

if [ -n "$DSH_VERSION" ]; then
  DSH="$PROXY_PREFIX pnpx @deepseek-ai/dsh@$DSH_VERSION"
else
  DSH="dsh"
fi

# 注意：$DSH 需保留词拆分（含空格前缀），不要加引号
$DSH plugin --profile web remove dsh-subagent-workspace-ui 2>/dev/null || true
$DSH plugin --profile web add file:.
$DSH web --no-open --port "$PORT"
