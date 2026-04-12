#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Mr. Krabs 🦀 诊断脚本
# 用法：bash <(curl -fsSL https://raw.githubusercontent.com/melisaliao502-debug/mr-krabs/main/diagnose.sh)
# ──────────────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
fail() { echo -e "  ${RED}❌${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠️ ${NC} $1"; }
info() { echo -e "  ${CYAN}ℹ️ ${NC} $1"; }

APP="/Applications/Mr. Krabs.app"
ASAR="$APP/Contents/Resources/app.asar"
BUNDLE_ID="com.mrk.mr-krabs"
REPORT="/tmp/mr-krabs-diagnose-$(date +%Y%m%d-%H%M%S).txt"

echo ""
echo -e "${BOLD}  🦀 Mr. Krabs 诊断报告${NC}"
echo    "  ══════════════════════════════════════"
echo    "  $(date)"
echo    "  报告将保存到: $REPORT"
echo ""

# 重定向到文件同时显示
exec > >(tee "$REPORT") 2>&1

# ──────────────────────────────────────────────
# 1. 系统环境
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 1. 系统环境 ]${NC}"
info "macOS: $(sw_vers -productVersion)"
info "芯片:  $(uname -m)"
info "用户:  $(whoami)"
echo ""

# ──────────────────────────────────────────────
# 2. 安装状态
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 2. 安装状态 ]${NC}"
if [ -d "$APP" ]; then
  VER=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "未知")
  ok "已安装 — 版本: v$VER"

  # 版本对比（v0.6.11+ 修复了权限 bug）
  MAJOR=$(echo "$VER" | cut -d. -f1)
  MINOR=$(echo "$VER" | cut -d. -f2)
  PATCH=$(echo "$VER" | cut -d. -f3)
  if [ "$MAJOR" -gt 0 ] || [ "$MINOR" -gt 6 ] || ([ "$MINOR" -eq 6 ] && [ "$PATCH" -ge 11 ]); then
    ok "版本 v$VER ≥ v0.6.11（已包含权限修复）"
  else
    fail "版本 v$VER < v0.6.11 — 需要更新！权限 bug 未修复"
    warn "请运行: curl -fsSL https://raw.githubusercontent.com/melisaliao502-debug/mr-krabs/main/install.sh | bash"
  fi
else
  fail "未安装 — $APP 不存在"
fi
echo ""

# ──────────────────────────────────────────────
# 3. 代码内部逻辑检查（从 asar 提取验证）
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 3. 代码逻辑验证（asar 内容）]${NC}"
if [ -f "$ASAR" ]; then
  # 检查关键标志
  if strings "$ASAR" 2>/dev/null | grep -q "_accessibilityPromptCooldown"; then
    ok "防重复弹窗 cooldown 机制存在"
  else
    fail "没有 cooldown 机制 — 会持续弹窗"
  fi

  # 注意：strings 无法识别中文，用 ASCII 标记字符串检测自定义弹窗
  if strings "$ASAR" 2>/dev/null | grep -q "_accessibilityPromptCooldown" && \
     strings "$ASAR" 2>/dev/null | grep -q "isTrustedAccessibilityClient"; then
    ok "自定义权限弹窗逻辑存在（cooldown + API 均检测到）"
  else
    fail "没有自定义弹窗逻辑 — 可能直接触发系统跳转"
  fi

  if strings "$ASAR" 2>/dev/null | grep -q "isTrustedAccessibilityClient"; then
    ok "Accessibility API 已集成"
  else
    warn "未找到 Accessibility API"
  fi

  # 检查 asar 内的 js 语法
  if command -v npx &>/dev/null; then
    TMPDIR_EXT=$(mktemp -d)
    npx --yes @electron/asar extract "$ASAR" "$TMPDIR_EXT" 2>/dev/null
    for f in main.js updater.js menu.js; do
      if [ -f "$TMPDIR_EXT/src/$f" ]; then
        if node --check "$TMPDIR_EXT/src/$f" 2>/dev/null; then
          ok "src/$f 语法正确"
        else
          fail "src/$f 有语法错误！这是 App 无法启动的原因"
          node --check "$TMPDIR_EXT/src/$f" 2>&1 | head -5
        fi
      fi
    done
    rm -rf "$TMPDIR_EXT"
  else
    warn "npx 不可用，跳过语法检查"
  fi
else
  fail "找不到 app.asar — 安装可能不完整"
fi
echo ""

# ──────────────────────────────────────────────
# 4. 辅助功能权限状态
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 4. 辅助功能权限 ]${NC}"
# 通过检查 TCC 数据库
TCC_USER="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
TCC_SYS="/Library/Application Support/com.apple.TCC/TCC.db"

check_tcc() {
  local db=$1
  local label=$2
  if [ -f "$db" ]; then
    local result
    result=$(sqlite3 "$db" \
      "SELECT auth_value FROM access WHERE service='kTCCServiceAccessibility' AND client='$BUNDLE_ID';" \
      2>/dev/null)
    if [ "$result" = "2" ]; then
      ok "$label — Mr. Krabs 辅助功能权限：已授权 ✓"
    elif [ "$result" = "0" ]; then
      fail "$label — Mr. Krabs 辅助功能权限：已拒绝"
    elif [ -z "$result" ]; then
      warn "$label — Mr. Krabs 辅助功能权限：从未授权（首次使用会弹窗）"
    else
      info "$label — auth_value=$result"
    fi
  fi
}

check_tcc "$TCC_USER" "用户 TCC"
check_tcc "$TCC_SYS"  "系统 TCC（需要 sudo）"

# 直接用 API 检查
AX_STATUS=$(osascript -e '
tell application "System Events"
  return (exists process "Mr. Krabs")
end tell' 2>/dev/null || echo "unknown")
info "System Events 可见进程: $AX_STATUS"
echo ""

# ──────────────────────────────────────────────
# 5. 进程状态
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 5. 进程状态 ]${NC}"
if pgrep -f "Mr. Krabs.app" > /dev/null 2>&1; then
  ok "Mr. Krabs（打包版）正在运行"
  pgrep -fl "Mr. Krabs.app" | grep "MacOS/Mr" | head -2 | while read line; do
    info "  $line"
  done
elif pgrep -f "mr-krabs" > /dev/null 2>&1; then
  warn "Mr. Krabs（开发版）正在运行（不是打包版）"
else
  fail "Mr. Krabs 未运行"
fi

# 端口检查
if nc -z 127.0.0.1 23333 2>/dev/null; then
  ok "State server 23333 端口正常监听"
else
  fail "23333 端口无响应（App 可能未完全启动）"
fi
echo ""

# ──────────────────────────────────────────────
# 6. 隔离属性
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 6. Gatekeeper / 隔离属性 ]${NC}"
if [ -d "$APP" ]; then
  QUAR=$(xattr -p com.apple.quarantine "$APP" 2>/dev/null || echo "")
  if [ -z "$QUAR" ]; then
    ok "无隔离属性（不会被 Gatekeeper 拦截）"
  else
    fail "有隔离属性: $QUAR"
    warn "修复命令: xattr -rd com.apple.quarantine \"$APP\""
  fi

  # 签名状态
  SIGN=$(codesign -dv "$APP" 2>&1 | grep "Authority\|TeamID\|Signature\|adhoc" | head -3)
  if echo "$SIGN" | grep -q "adhoc\|ad-hoc\|\-$"; then
    ok "Ad-hoc 签名（预期状态，无需开发者证书）"
  elif [ -z "$SIGN" ]; then
    fail "无签名 — 可能导致 macOS 拒绝运行"
  else
    info "签名: $SIGN"
  fi
fi
echo ""

# ──────────────────────────────────────────────
# 7. 最近崩溃日志
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 7. 崩溃日志 ]${NC}"
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
CRASH_FILES=$(ls -lt "$CRASH_DIR" 2>/dev/null | grep -i "krabs\|electron" | head -3)
if [ -n "$CRASH_FILES" ]; then
  warn "发现崩溃日志："
  echo "$CRASH_FILES" | while read line; do
    info "  $line"
  done
  # 读取最新崩溃日志的错误类型
  LATEST_CRASH=$(ls -t "$CRASH_DIR"/*.ips "$CRASH_DIR"/*.crash 2>/dev/null | xargs -I{} basename {} | grep -i "krabs\|electron" | head -1)
  if [ -n "$LATEST_CRASH" ]; then
    CRASH_TYPE=$(grep -m1 "Exception Type\|Exception Codes\|Termination Reason" "$CRASH_DIR/$LATEST_CRASH" 2>/dev/null | head -3)
    if [ -n "$CRASH_TYPE" ]; then
      warn "崩溃原因: $CRASH_TYPE"
    fi
  fi
else
  ok "无崩溃日志"
fi
echo ""

# ──────────────────────────────────────────────
# 8. 权限弹窗触发测试（模拟一次 openChatWindow）
# ──────────────────────────────────────────────
echo -e "${BOLD}[ 8. 权限行为实时测试 ]${NC}"
if nc -z 127.0.0.1 23333 2>/dev/null; then
  info "App 正在运行，下一步请手动按 Ctrl+Enter"
  info "观察是否出现「需要辅助功能权限」弹窗（而不是直接跳系统设置）"
  info "如果直接跳系统设置 = 版本仍是旧版，需要更新"
  info "如果出现弹窗含「去授权」按钮 = v0.6.11 正常工作 ✅"
else
  warn "App 未运行，请先打开 Mr. Krabs 再按 Ctrl+Enter 测试"
fi
echo ""

# ──────────────────────────────────────────────
# 汇总
# ──────────────────────────────────────────────
echo "  ══════════════════════════════════════"
echo -e "${BOLD}  📋 诊断完成${NC}"
echo    "  报告已保存到: $REPORT"
echo    ""
echo    "  请把这个文件内容发给木樱："
echo -e "  ${CYAN}cat $REPORT | pbcopy${NC}   (复制到剪贴板)"
echo ""
