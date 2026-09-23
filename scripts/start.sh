#!/usr/bin/env bash
#
# GPT-SoVITS 本地服务启动器（Linux / macOS）。
#
# 本脚本只负责一件事：**挑对解释器，然后把控制权交给 trainer/server.py**。
#
# 为什么「挑对解释器」值得单独写一个脚本：
# torch 装在 GPT-SoVITS 整合包自带的 runtime 里；用系统 Python 启动本服务
# 会在 `import torch` 时直接失败。这里按顺序探测，并以「能否 import torch」
# 作为最终判据 —— 而不是猜路径。
#
# 用法：
#   ./scripts/start.sh                        # 本地模式
#   ./scripts/start.sh --check                # 只做环境体检
#   ./scripts/start.sh --home /opt/GPT-SoVITS
#   ./scripts/start.sh --mode public --port 9881

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TRAINER_DIR="${ROOT}/trainer"

C_RESET='\033[0m'; C_GREEN='\033[32m'; C_CYAN='\033[36m'; C_YELLOW='\033[33m'; C_RED='\033[31m'

step() { printf "  ${C_CYAN}· %s${C_RESET}\n" "$*"; }
warn() { printf "  ${C_YELLOW}! %s${C_RESET}\n" "$*"; }
fail() { printf "\n  ${C_RED}[×] %s${C_RESET}\n\n" "$*" >&2; exit 1; }

can_import() {
  # $1=解释器 $2=模块列表
  "$1" -c "import $2" >/dev/null 2>&1
}

printf '\n  %sGPT-SoVITS 本地服务 · 启动器%s\n\n' "${C_GREEN}" "${C_RESET}"

[ -f "${TRAINER_DIR}/server.py" ] || fail "未找到 Python 服务入口：${TRAINER_DIR}/server.py"

# ---------- 1. 选择解释器 ----------
EXPLICIT_HOME=""
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = "--home" ]; then
    j=$((i + 1))
    EXPLICIT_HOME="${!j:-}"
  fi
done

CANDIDATES=()
if [ -n "${EXPLICIT_HOME}" ]; then
  CANDIDATES+=(
    "${EXPLICIT_HOME}/runtime/python.exe"
    "${EXPLICIT_HOME}/runtime/bin/python3"
    "${EXPLICIT_HOME}/runtime/bin/python"
    "${EXPLICIT_HOME}/venv/bin/python"
    "${EXPLICIT_HOME}/.venv/bin/python"
  )
fi
for dir in "${ROOT}"/[Gg][Pp][Tt][-_]*[Ss][Oo][Vv][Ii][Tt][Ss]*; do
  [ -d "${dir}" ] || continue
  CANDIDATES+=(
    "${dir}/runtime/python.exe"
    "${dir}/runtime/bin/python3"
    "${dir}/runtime/bin/python"
    "${dir}/venv/bin/python"
    "${dir}/.venv/bin/python"
  )
done

PYTHON=""
for candidate in "${CANDIDATES[@]:-}"; do
  [ -n "${candidate}" ] || continue
  [ -x "${candidate}" ] || continue
  step "探测整合包解释器：${candidate}"
  if can_import "${candidate}" torch; then
    PYTHON="${candidate}"
    break
  fi
done

if [ -z "${PYTHON}" ]; then
  for name in python3 python; do
    command -v "${name}" >/dev/null 2>&1 || continue
    if can_import "${name}" torch; then
      PYTHON="${name}"
      break
    fi
  done
fi

if [ -z "${PYTHON}" ]; then
  warn '没有找到能 import torch 的解释器'
  printf '\n'
  printf '  服务仍然可以启动，但推理与训练会不可用。请任选一种方式解决：\n'
  printf '    1) 把 GPT-SoVITS 整合包放在本项目同级目录（推荐，自带 runtime 与 torch）\n'
  printf '    2) 用 --home 指定整合包根目录，例如： ./scripts/start.sh --home /opt/GPT-SoVITS\n'
  printf '    3) 在你自己的 Python 环境里装好 torch 后，用该解释器启动 trainer/server.py\n\n'
  for name in python3 python; do
    if command -v "${name}" >/dev/null 2>&1; then PYTHON="${name}"; break; fi
  done
  [ -n "${PYTHON}" ] || fail '连一个可用的 Python 都没有，请先安装 Python 3.9+'
fi

step "使用解释器：${PYTHON}"

# ---------- 2. 补齐服务依赖 ----------
SKIP_INSTALL=0
for arg in "$@"; do
  [ "${arg}" = "--skip-install" ] && SKIP_INSTALL=1
done

if [ "${SKIP_INSTALL}" -eq 0 ]; then
  step '检查服务依赖（fastapi / uvicorn / pydantic / python-multipart / PyYAML）'
  if can_import "${PYTHON}" 'fastapi, uvicorn, pydantic, multipart, yaml'; then
    step '依赖已就绪'
  else
    step '正在安装缺失依赖…'
    "${PYTHON}" -m pip install -r "${TRAINER_DIR}/requirements.txt" --disable-pip-version-check \
      || warn '依赖安装失败（可能是没有网络）。若整合包环境已自带这些包，可加 --skip-install 跳过'
  fi
fi

# ---------- 3. 交给 server.py ----------
step '交给 server.py 做环境体检'
printf '\n'

ARGS=()
for arg in "$@"; do
  # 我们的包装参数不传给 server.py
  [ "${arg}" = "--skip-install" ] && continue
  ARGS+=("${arg}")
done

cd "${TRAINER_DIR}"
exec "${PYTHON}" server.py \
  ${ARGS[@]+"${ARGS[@]}"}
