# Deploying Kloru

One always-on Fly.io machine in San Jose runs the website, the voice service and the agent.
Postgres is Neon; backups (and later files) go to Cloudflare R2; DNS is Cloudflare.

```
caller ─► Twilio ─► voice.kloru.com ─┐
browser ───────────► kloru.com ──────┤  (www and app redirect to kloru.com)  Cloudflare DNS (DNS only) → Fly edge (TLS)
                                     ▼
          Fly machine "kloru" (sjc, always on), Caddy :8000 routes by host
            kloru.com       → website  127.0.0.1:8790   (packages/web)
            voice.kloru.com → voice    127.0.0.1:8765   (voice/)
            agent           →          127.0.0.1:8080   (packages/server, never public)
            /data volume: instinct/ (agent state), kloru/ (console file store, if no DB)
          outbound: Neon · R2 · OpenRouter · Deepgram · Cartesia · Composio · Twilio
```

Files: `fly.toml`, `deploy/kloru/Dockerfile`, `deploy/kloru/Caddyfile`, `deploy/kloru/run.sh`
(starts everything and exits if any part dies, so Fly restarts the machine),
`deploy/kloru/secrets.sh`.

## Secrets

`deploy/kloru/secrets.sh` stages every key from `voice/.env`, `.instinct.env`, `.kloru.env` and
`.kloru.cloud.env` (all git-ignored) with `fly secrets import`, without printing values. The voice
service's OpenRouter key is stored as `VOICE_OPENROUTER_API_KEY`. `.kloru.cloud.env` holds:

```
DATABASE_URL=postgres://...neon.tech/kloru?sslmode=require
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=kloru-data
BACKUP_KEY=<openssl rand -hex 32>   # keep a copy outside Fly and R2
```

## First deploy

```
fly apps create kloru --org <org>
fly volumes create kloru_data --app kloru --region sjc --size 3
deploy/kloru/secrets.sh
fly deploy
fly certs add kloru.com && fly certs add www.kloru.com && fly certs add app.kloru.com && fly certs add voice.kloru.com
# Cloudflare: kloru.com, www, app and voice → CNAME kloru.fly.dev, DNS only (grey cloud)
```

Move the local agent state in through the backup path (which also proves restore works):
`KLORU_BACKUP_DIR=<staging dir with instinct/ and kloru/> node packages/web/dist/backup.js`
locally, then `fly ssh console -C "node /app/packages/web/dist/backup.js restore /data"` and
`fly machine restart`.

Switch calls: set the Twilio number's VoiceUrl to `https://voice.kloru.com/twilio/voice` (done
2026-10-27). To run calls from a laptop again, start the voice service and a tunnel locally, set
`PUBLIC_URL` to the tunnel's URL, and point the VoiceUrl there; point it back here afterwards.

## Day to day

- Logs: `fly logs`. Shell: `fly ssh console`.
- Deploy: push to `main`. When the `ci` workflow passes, `.github/workflows/deploy.yml` runs
  `flyctl deploy` on that commit, using the repo secret `FLY_API_TOKEN` (a deploy token for this
  app only: `fly tokens create deploy -a kloru -x 8760h | gh secret set FLY_API_TOKEN -R kloru/kloru`;
  it expires after a year). By hand, when Actions is down: `fly deploy` from a clean checkout of `main`.
- Bigger CPU if calls lag: `fly scale vm performance-1x`.
- Backups: nightly to `r2://kloru-data/backups/YYYY/MM/DD/`, deleted after 30 days by the bucket
  lifecycle rule; Fly also snapshots the volume daily (7 kept).
- Restore: `fly ssh console -C "node /app/packages/web/dist/backup.js restore /data"`, then restart.

## Caller ID

The voice service answers only the owner's number, and only when the caller's carrier vouches
for the caller ID with full STIR/SHAKEN attestation (`StirVerstat=TN-Validation-Passed-A`);
anything less is hung up, since caller ID is easy to fake. Every call (connected, hung up, unknown number, forged request) is written to
`/data/voice/calls.jsonl`, kept 90 days and backed up nightly; the website's Admin page shows the
last 7 days and the 50 most recent calls. Each connected call's transcript (what was said, and
every background task's request and result) is in `/data/voice/transcripts/<date>/<CallSid>.jsonl`,
kept 90 days, and opens from the call's row on the Admin page. If your own calls start getting dropped (a carrier change, travel
abroad, Wi-Fi calling through an app), check `fly logs`, and to get back in temporarily:
`fly secrets set VOICE_REQUIRE_ATTESTATION=off -a kloru` (unset it afterwards).

## Your own Kloru

This page is how kloru.com itself runs. To run your own, with your own accounts and domain, follow [SETUP.md](../SETUP.md).
