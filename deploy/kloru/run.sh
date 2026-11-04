#!/usr/bin/env bash
# Start everything in one machine and stop if any part dies, so Fly restarts the machine.
set -uo pipefail

if [ "$(id -u)" = "0" ]; then
  # Fly mounts the volume root-owned: make it ours, then drop root for good.
  mkdir -p /data/instinct /data/kloru /data/voice
  chown -R kloru:kloru /data
  exec setpriv --reuid=kloru --regid=kloru --init-groups "$0" "$@"
fi

export HOME=/home/kloru XDG_CONFIG_HOME=/home/kloru/.config XDG_DATA_HOME=/home/kloru/.local/share
cd /app
pids=()

caddy run --config /app/deploy/kloru/Caddyfile --adapter caddyfile &
pids+=($!)

# The agent: loopback only; the website and the voice service are its only callers.
KLORU_VOICE_PREFS=/data/voice/prefs.json INSTINCT_DATA_DIR=/data/instinct INSTINCT_BIND=127.0.0.1 PORT=8080 node packages/server/dist/main.js &
pids+=($!)

# The voice service has its own OpenRouter key (kloru-voice); the agent keeps OPENROUTER_API_KEY (kloru-agent).
(cd /app/voice && CALL_LOG_PATH=/data/voice/calls.jsonl TRANSCRIPTS_DIR=/data/voice/transcripts VOICE_PREFS_PATH=/data/voice/prefs.json OPENROUTER_API_KEY="${VOICE_OPENROUTER_API_KEY:-${OPENROUTER_API_KEY:-}}" exec python -m voice.main) &
pids+=($!)

KLORU_CALL_LOG=/data/voice/calls.jsonl KLORU_TRANSCRIPTS=/data/voice/transcripts KLORU_DESK_DIR=/data/instinct/repo KLORU_ALERTS=/data/voice/alerts.jsonl KLORU_VOICE_PREFS=/data/voice/prefs.json KLORU_DATA_DIR=/data/kloru KLORU_BIND=127.0.0.1 KLORU_PORT=8790 node packages/web/dist/main.js &
pids+=($!)

# Nightly encrypted backup of /data to R2, first one 10 minutes after boot.
if [ -n "${R2_BUCKET:-}" ] && [ -n "${BACKUP_KEY:-}" ]; then
  (sleep 600; while true; do KLORU_BACKUP_DIR=/data node packages/web/dist/backup.js || echo "[backup] will retry tomorrow"; sleep 86400; done) &
fi

# Every service stops on its own, then everything they wrote reaches the disk before the machine goes.
stop() { kill "${pids[@]}" 2>/dev/null; wait; sync; }
trap 'stop; exit 0' TERM INT

wait -n "${pids[@]}"
code=$?
echo "[kloru] a service exited (code $code); stopping the machine so Fly restarts it"
stop
exit 1
