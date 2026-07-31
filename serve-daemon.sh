#!/bin/bash

export PATH="${MDREAD_BIN_DIR:+$MDREAD_BIN_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${MDREAD_PROJECT_DIR:-$SCRIPT_DIR}"
DATA_DIR="${MDREAD_DATA_DIR:-$PROJECT_DIR/.mdread}"
SERVER_LOG="${MDREAD_SERVER_LOG:-/tmp/mdread-server.log}"
TUNNEL_LOG="${MDREAD_TUNNEL_LOG:-/tmp/mdread-tunnel.log}"
TUNNEL_PREV_LOG="${MDREAD_TUNNEL_PREV_LOG:-/tmp/mdread-tunnel.prev.log}"
CHECK_INTERVAL="${MDREAD_CHECK_INTERVAL:-5}"

cd "$PROJECT_DIR" || exit 1
command -v node >/dev/null 2>&1 || { echo "md-read daemon: node 不可用" >&2; exit 127; }
command -v cloudflared >/dev/null 2>&1 || { echo "md-read daemon: cloudflared 不可用" >&2; exit 127; }
command -v curl >/dev/null 2>&1 || { echo "md-read daemon: curl 不可用" >&2; exit 127; }

mkdir -p "$DATA_DIR" || exit 1
chmod 700 "$DATA_DIR" || exit 1
printf '%s' "我" > "$DATA_DIR/owner" || exit 1
chmod 600 "$DATA_DIR/owner" || exit 1
export MDREAD_DATA_DIR="$DATA_DIR"

NODE_PID=""
CF_PID=""
PORT=""
fails=0
CLEANING=0

stop_tunnel() {
  rm -f "$DATA_DIR/url" "$DATA_DIR/.url.$$"
  if [ -n "$CF_PID" ]; then
    kill "$CF_PID" 2>/dev/null || true
    wait "$CF_PID" 2>/dev/null || true
    CF_PID=""
  fi
}

cleanup() {
  [ "$CLEANING" -eq 1 ] && return
  CLEANING=1
  stop_tunnel
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    NODE_PID=""
  fi
}

trap cleanup EXIT
trap 'exit 0' TERM INT HUP

start_node() {
  rm -f "$DATA_DIR/port"
  node "$PROJECT_DIR/server.js" >"$SERVER_LOG" 2>&1 &
  NODE_PID=$!
}

get_port() {
  local p="" i
  for i in $(seq 1 20); do
    p=$(awk 'NR==1 && /^[0-9]+$/ { print; exit }' "$DATA_DIR/port" 2>/dev/null)
    [ -n "$p" ] && { echo "$p"; return 0; }
    kill -0 "$NODE_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

start_tunnel() {
  stop_tunnel
  [ -s "$TUNNEL_LOG" ] && mv -f "$TUNNEL_LOG" "$TUNNEL_PREV_LOG"
  cloudflared tunnel --url "http://127.0.0.1:$PORT" >"$TUNNEL_LOG" 2>&1 &
  CF_PID=$!
  local u="" i
  for i in $(seq 1 30); do
    u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | grep -v '://api\.' | head -1)
    if [ -n "$u" ]; then
      if ! printf '%s' "$u" > "$DATA_DIR/.url.$$" ||
         ! chmod 600 "$DATA_DIR/.url.$$" ||
         ! mv -f "$DATA_DIR/.url.$$" "$DATA_DIR/url"; then
        stop_tunnel
        return 1
      fi
      fails=0
      return 0
    fi
    kill -0 "$CF_PID" 2>/dev/null || break
    sleep 1
  done
  stop_tunnel
  return 1
}

start_node
PORT=$(get_port) || { echo "md-read daemon: Node 服务未就绪" >&2; exit 1; }

while true; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    wait "$NODE_PID" 2>/dev/null || true
    NODE_PID=""
    # 旧 Tunnel 正在指向已经退出的 Node，先撤销公网入口再等待新端口。
    stop_tunnel
    start_node
    PORT=$(get_port) || { echo "md-read daemon: Node 重启失败" >&2; exit 1; }
  fi

  if [ -z "$CF_PID" ] || ! kill -0 "$CF_PID" 2>/dev/null; then
    [ -n "$CF_PID" ] && wait "$CF_PID" 2>/dev/null || true
    CF_PID=""
    start_tunnel || true
  elif [ -s "$DATA_DIR/url" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$(cat "$DATA_DIR/url")/static/app.html")
    if [ "$code" = "200" ]; then fails=0; else fails=$((fails+1)); fi
    if [ "$fails" -ge 2 ]; then
      stop_tunnel
      fails=0
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
