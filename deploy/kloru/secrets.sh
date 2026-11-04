#!/usr/bin/env bash
# Push the service's secrets to Fly from the local env files, without printing them.
# The voice service's OpenRouter key goes in as VOICE_OPENROUTER_API_KEY (run.sh maps it).
# Cloud-specific values (URLs, ports) live in fly.toml [env], so they are dropped here.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="${FLY_APP:-kloru}"
drop='^(PUBLIC_URL|INSTINCT_URL|KLORU_PUBLIC_URL|KLORU_DATA_DIR|KLORU_DEV_AGENT_URL|KLORU_BIND|KLORU_PORT|VOICE_PORT|INSTINCT_DATA_DIR|OPENROUTER_API_KEY)='
{
  grep -E '^[A-Z0-9_]+=' voice/.env | grep -Ev "$drop"
  grep -E '^OPENROUTER_API_KEY=' voice/.env | sed 's/^OPENROUTER_API_KEY=/VOICE_OPENROUTER_API_KEY=/'
  grep -E '^[A-Z0-9_]+=' .instinct.env | grep -Ev '^(INSTINCT_CHAT_TOKEN)=' | grep -Ev "^(INSTINCT_URL|INSTINCT_DATA_DIR)="
  grep -E '^[A-Z0-9_]+=' .kloru.env | grep -Ev "$drop"
  [ -f .kloru.cloud.env ] && grep -E '^[A-Z0-9_]+=' .kloru.cloud.env
  [ -f .kloru.langfuse.env ] && grep -E '^LANGFUSE_[A-Z_]+=' .kloru.langfuse.env | sed -E 's/="(.*)"$/=\1/'
} | awk -F= '!seen[$1]++' | fly secrets import --app "$APP" --stage
echo "staged secrets for $APP: $(fly secrets list --app "$APP" --json | grep -ci '"name"') names (values not shown); they apply on the next deploy"
