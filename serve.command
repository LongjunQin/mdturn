#!/bin/bash
# ───────────────────────────────────────────────────────────
#  md-read 常驻服务(Codex 版)—— 双击启动后一直开着
#  起本地服务 + Cloudflare 外网隧道,并把当前外网网址写给 mdshare 用。
#  之后 Codex 跑 `node mdshare.js <某篇.md>` 就能拿到可发给你的链接。
#  需先装一次:  brew install cloudflared
# ───────────────────────────────────────────────────────────
#
#  你的署名(批注默认记成谁;给别人看时用 mdshare --for 覆盖):
OWNER="我"
# ───────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
mkdir -p .mdread
printf '%s' "$OWNER" > .mdread/owner

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "❌ 还没装 cloudflared。先在终端运行:  brew install cloudflared"
  echo "(没有 Homebrew 就先装:https://brew.sh )"; echo "按回车关闭…"; read _; exit 1
fi

node server.js >/tmp/mdread-server.log 2>&1 &
NODE_PID=$!
trap 'rm -f .mdread/url; kill $NODE_PID $CF_PID 2>/dev/null' EXIT
PORT=""
for i in $(seq 1 15); do
  PORT=$(awk 'NR==1 && /^[0-9]+$/ { print; exit }' .mdread/port 2>/dev/null)
  [ -n "$PORT" ] && break; sleep 1
done
[ -z "$PORT" ] && { echo "本地服务没起来,看 /tmp/mdread-server.log"; read _; exit 1; }

echo "正在建立外网隧道(几秒)…"
cloudflared tunnel --url "http://127.0.0.1:$PORT" >/tmp/mdread-tunnel.log 2>&1 &
CF_PID=$!
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/mdread-tunnel.log | head -1)
  [ -n "$URL" ] && break; sleep 1
done
[ -z "$URL" ] && { echo "⚠️ 没抓到隧道网址,看 /tmp/mdread-tunnel.log"; read _; exit 1; }

printf '%s' "$URL" > .mdread/url
chmod 600 .mdread/url
echo "────────────────────────────────────────────────────────"
echo "  ✅ 服务已就绪。外网基址:$URL"
echo "  现在让 Codex / Claude Code 跑:"
echo "      node \"$(pwd)/mdshare.js\" \"<某篇文档.md>\"  [--for 姓名] [--days N]"
echo "  它会输出一条可直接发给你的链接。"
echo "  这个窗口保持开着(服务在跑)。停止:Ctrl + C"
echo "────────────────────────────────────────────────────────"
wait
