#!/usr/bin/env sh
# 运行 s5 复杂度检查。检查器路径只从环境变量 S5_CHECK 读，写法与插件 README 一致：
#   S5_CHECK="$ARTHURPOWER_PLUGIN_ROOT/scripts/s5-complexity/check.mjs"
# 两个变量设在用户级 ~/.claude/settings.json 的 env 或 shell 里，不进仓库。
# 未设置或文件不存在（插件不在，如 CI、公开镜像克隆）：显式报 Not run，退出 0。
# 文件存在但不可执行：配置有误，报错退出 2（与插件入口一致）。
if [ -z "${S5_CHECK:-}" ] || [ ! -f "$S5_CHECK" ]; then
  echo "[s5-check] Not run: S5_CHECK not set or file missing" >&2
  exit 0
fi
if [ ! -x "$S5_CHECK" ]; then
  echo "[s5-check] ERROR: S5_CHECK is not executable: $S5_CHECK" >&2
  exit 2
fi
exec "$S5_CHECK" "$@"
