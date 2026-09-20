#!/usr/bin/env bash
# dsh-subagent-workspace-ui smoke runner —— 环境相关冒烟脚本，非单测。
#
# 用法：
#   ./test.sh [PORT]                          # 本地 dsh（默认版本）跑 web，端口 ${PORT:-8084}
#   DSH_VERSION=0.1.1-rc.2 ./test.sh [PORT]   # 用 pnpx 拉取指定 dsh 版本跑 web
#   DSH_SMOKE_HOME=/path ./test.sh [PORT]     # 覆盖测试 HOME（默认 $HOME/tmp/dsh-test）
#   source test.sh [PORT]                     # 也可 source（此时用 DSH_VERSION 等环境变量）
#
# 说明：
#   - DSH_HOME 固定用独立测试目录：默认 $HOME/tmp/dsh-test，可用 DSH_SMOKE_HOME=/path 覆盖。
#     刻意不继承外层的 DSH_HOME——在 DSH 会话里 DSH_HOME 指向真实 profile（~/.dsh），
#     沿用它会去改真实 profile 的插件依赖（remove/add），务必隔离。
#   - DSH_VERSION 非空时，用 `pnpx @deepseek-ai/dsh@<version>` 运行；默认经
#     `proxychains4 -q` 走代理拉取并运行（可用 DSH_PROXY 覆盖，例如 DSH_PROXY="" 表示直连）。
#   - pnpm 12 默认忽略依赖的 install/postinstall 脚本，dsh 的原生依赖因此装不起来
#     （ERR_PNPM_IGNORED_BUILDS）；这里显式用 --allow-build 逐个放行，
#     清单可用 DSH_ALLOW_BUILDS 覆盖（逗号分隔）。
#   - remove/add 与 web 都走同一个调用入口，保证 profile 由目标 dsh 版本管理（幂等重跑安全）。
#   - 插件源默认当前仓库根（file:.），可用 DSH_PLUGIN_DIR=.worktrees/xxx 冒烟某个 worktree 产物。
#   - 不要用 alias 定义 dsh：非交互 bash 默认不展开 alias（expand_aliases 关闭），
#     `bash ./test.sh` 会直接报 "DSH: command not found"；这里用数组 + 函数。

DSH_HOME="${DSH_SMOKE_HOME:-$HOME/tmp/dsh-test}"
export DSH_HOME

case "$DSH_HOME" in
  "$HOME/.dsh"|"$HOME/.dsh/")
    echo "[test.sh] ERROR: 拒绝把真实 profile（$DSH_HOME）当冒烟目录。" >&2
    echo "[test.sh]        请用 DSH_SMOKE_HOME=/path 指定独立目录。" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="${DSH_PLUGIN_DIR:-$SCRIPT_DIR}"
cd "$PLUGIN_DIR"

if [ ! -f package.json ]; then
  echo "[test.sh] ERROR: DSH_PLUGIN_DIR=$PLUGIN_DIR 下没有 package.json。" >&2
  exit 1
fi

PORT="${1:-8084}"
DSH_VERSION="${DSH_VERSION:-}"
# 允许 DSH_PROXY="" 表示直连，所以这里用不带冒号的默认值展开
PROXY_PREFIX="${DSH_PROXY-proxychains4 -q}"
# dsh 的原生/构建依赖；缺一个 pnpx 就会以 ERR_PNPM_IGNORED_BUILDS 退出
DSH_ALLOW_BUILDS="${DSH_ALLOW_BUILDS-@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs}"

# 词拆分由数组承担，避免把带空格的代理前缀当成命令名
if [ -n "$DSH_VERSION" ]; then
  DSH_CMD=()
  if [ -n "$PROXY_PREFIX" ]; then
    read -r -a DSH_CMD <<<"$PROXY_PREFIX"
  fi
  DSH_CMD+=(pnpx)
  if [ -n "$DSH_ALLOW_BUILDS" ]; then
    IFS=',' read -r -a DSH_BUILD_ALLOW <<<"$DSH_ALLOW_BUILDS"
    for pkg in "${DSH_BUILD_ALLOW[@]}"; do
      DSH_CMD+=("--allow-build=$pkg")
    done
  fi
  DSH_CMD+=("@deepseek-ai/dsh@$DSH_VERSION")
else
  DSH_CMD=(dsh)
fi

dsh_run() {
  "${DSH_CMD[@]}" "$@"
}

echo "[test.sh] DSH_HOME=$DSH_HOME port=$PORT cmd=${DSH_CMD[*]}"

# 早失败：pnpm 在 DSH_HOME 里写 package.json.lock，只读目录下会抛出难读的 EROFS 栈
mkdir -p "$DSH_HOME" 2>/dev/null || true
if [ ! -w "$DSH_HOME" ]; then
  echo "[test.sh] ERROR: DSH_HOME=$DSH_HOME 不可写。" >&2
  echo "[test.sh]        沙盒只读 \$HOME 时请改用：DSH_SMOKE_HOME=\"\$PWD/tmp/dsh-test\" $0 $PORT" >&2
  exit 1
fi

dsh_run plugin --profile web remove dsh-subagent-workspace-ui 2>/dev/null || true

dsh_run plugin --profile web add file:.
dsh_run web --no-open --port "$PORT"
