---
name: setup-kloru
description: Use when someone asks to set up, install, deploy or self-host their own Kloru (their own accounts and domain). Walks them through SETUP.md, with them making every account, keys going only into kloru.env, and a yes before anything is bought.
---

# Set up Kloru

Follow [SETUP.md](../../../SETUP.md) from the top, section by section, and its **For agents**
rules: they make the accounts and pay, keys go only into `kloru.env` (never through chat, never
printed), the plan is shown before `--apply`, and DNS is theirs to add.

1. Check their tools (git, node 22.19+, pnpm 10, uv, flyctl); offer the install line if any are missing.
2. `cp kloru.env.example kloru.env` if it doesn't exist.
3. Section 1: one service at a time. Say what to click and which line of `kloru.env` the key goes
   on. Then wait for them before moving to the next service.
4. `python3 deploy/selfhost/setup.py --check` until it says Ready.
5. Ask for their domain, name, phone, email and area code. Run setup without `--apply` and show them the plan.
6. After their yes, run it with `--apply`. Show them the DNS record it prints, then watch
   `fly certs show` until the certificate is issued.
7. Confirm `/healthz` and `desk: ready`, then send them to sign in at their domain. The Get
   started page takes it from there.
