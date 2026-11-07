#!/usr/bin/env python3
"""Set up your own Kloru on Fly.io, with your own accounts and your own domain. See SETUP.md.

    python3 deploy/selfhost/setup.py --check                     # what's ready, what's missing
    python3 deploy/selfhost/setup.py --domain kloru.example.com \\
        --owner-name "Sam Lee" --owner-phone "+1 415 555 0100" --owner-email sam@example.com \\
        --area-code 415                                          # print the plan; nothing happens
    ... --apply                                                  # do it (paid steps are marked)
    python3 deploy/selfhost/setup.py --update                    # the latest Kloru, rolled back if it fails

Every step checks what already exists, so running it again picks up where it stopped (or applies a
changed key) without buying anything twice. A domain of <app>.fly.dev needs no DNS at all.

Keys come from kloru.env (copy kloru.env.example). Generated secrets are made once and kept in
.selfhost/<app>.env (git-ignored): keep that file, it holds the backup and vault keys, which can't
be recovered. No value is ever printed.
"""
import argparse
import base64
import json
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).with_name("fly.template.toml")

REQUIRED = [
    "OPENROUTER_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID",
    "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID", "INKBOX_API_KEY", "COMPOSIO_API_KEY",
]
OPTIONAL = [
    "RESEND_API_KEY", "KLORU_MAIL_FROM", "STEEL_API_KEY", "STRIPE_PUBLISHABLE_KEY", "LINK_CLIENT_ID", "LINK_CLIENT_SECRET",
    "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
]
GENERATED = ["KLORU_SESSION_SECRET", "INSTINCT_CHAT_TOKEN", "OWNER_API_SECRET", "BACKUP_KEY", "KLORU_VAULT_KEY"]
INKBOX = "https://inkbox.ai/api/v1"


@dataclass
class Owner:
    name: str
    phone: str
    email: str
    timezone: str = "America/Los_Angeles"


@dataclass
class Step:
    name: str
    detail: str
    costs: bool = False
    run: object = field(default=None, repr=False)
    # Returns what already exists ("kloru_data exists"), so the step is skipped; None to run it.
    done: object = field(default=None, repr=False)


def e164(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        digits = "1" + digits
    if not 11 <= len(digits) <= 15:
        raise SystemExit(f"not a phone number: {phone!r}")
    return "+" + digits


def check_domain(domain: str) -> str:
    d = domain.strip().lower().removeprefix("https://").removeprefix("http://").rstrip("/")
    if not re.fullmatch(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", d):
        raise SystemExit(f"not a domain: {domain!r} (for example kloru.example.com)")
    return d


def on_fly(domain: str) -> bool:
    """<app>.fly.dev: Fly's own address, with its certificate; no domain or DNS needed."""
    return domain.endswith(".fly.dev") and domain.count(".") == 2


def default_app(domain: str) -> str:
    """kloru.example.com → kloru-example; Fly app names are global, so a clash is caught at create."""
    if on_fly(domain):
        return domain.split(".")[0]
    labels = domain.split(".")
    base = "-".join(labels[:-1])[:40] if len(labels) > 1 else domain
    return re.sub(r"[^a-z0-9-]", "-", base if base.startswith("kloru") else f"kloru-{base}").strip("-")


def handle_for(app: str) -> str:
    return app.removeprefix("kloru-") + "-kloru" if app.startswith("kloru-") else f"{app}-kloru"


def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def generate_secrets() -> dict[str, str]:
    return {
        "KLORU_SESSION_SECRET": secrets.token_urlsafe(48),
        "INSTINCT_CHAT_TOKEN": secrets.token_urlsafe(32),
        "OWNER_API_SECRET": secrets.token_urlsafe(32),
        "BACKUP_KEY": secrets.token_hex(32),
        "KLORU_VAULT_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
    }


def generated_path(app: str) -> Path:
    return ROOT / ".selfhost" / f"{app}.env"


def load_or_generate(app: str) -> dict[str, str]:
    """Made once and kept; a re-run only adds what's missing (BACKUP_KEY and KLORU_VAULT_KEY must never change)."""
    path = generated_path(app)
    existing = read_env(path)
    if all(k in existing for k in GENERATED):
        return {k: existing[k] for k in GENERATED}
    fresh = {**generate_secrets(), **{k: v for k, v in existing.items() if k in GENERATED}}
    path.parent.mkdir(exist_ok=True)
    path.write_text("".join(f"{k}={v}\n" for k, v in fresh.items()))
    path.chmod(0o600)
    return fresh


def secrets_for(owner: Owner, keys: dict[str, str], generated: dict[str, str], handle: str) -> dict[str, str]:
    phone = e164(owner.phone)
    out = {k: keys[k] for k in REQUIRED + OPTIONAL if keys.get(k)}
    # The voice service reads its own OpenRouter key name.
    out["VOICE_OPENROUTER_API_KEY"] = keys["OPENROUTER_API_KEY"] if keys.get("OPENROUTER_API_KEY") else ""
    out.update({k: generated[k] for k in GENERATED})
    out.update({
        "INKBOX_AGENT_HANDLE": handle,
        "OWNER_PHONE": phone, "INSTINCT_OWNER_PHONE": phone, "KLORU_ADMIN_PHONES": phone,
        "INSTINCT_OWNER_NAME": owner.name, "INSTINCT_OWNER_EMAIL": owner.email, "INSTINCT_OWNER_TIMEZONE": owner.timezone,
    })
    return {k: v for k, v in out.items() if v}


def render_fly_toml(app: str, region: str, domain: str, text_number: str, operator: str, contact: str) -> str:
    return TEMPLATE.read_text().format(app=app, region=region, domain=domain, text_number=text_number, operator=operator.replace('"', ""), contact=contact)


# Remote calls -----------------------------------------------------------------------------


def sh(*args: str, stdin: str | None = None) -> str:
    """Run a command; on failure, stop with what it said (its output never holds a key's value)."""
    r = subprocess.run(args, input=stdin, capture_output=True, text=True)
    if r.returncode != 0:
        said = (r.stderr.strip() or r.stdout.strip())[-1500:]
        raise SystemExit(f"`{' '.join(args[:4])}` failed:\n{said}")
    return r.stdout


def ok(*args: str) -> bool:
    return subprocess.run(args, capture_output=True, text=True).returncode == 0


def fly_json(*args: str):
    r = subprocess.run(["fly", *args, "--json"], capture_output=True, text=True)
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except json.JSONDecodeError:
        return None


def http(method: str, url: str, *, headers: dict[str, str], body: dict | None = None, form: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else urllib.parse.urlencode(form).encode() if form is not None else None
    h = {"Accept": "application/json", **headers, **({"Content-Type": "application/json"} if body is not None else {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method=method, data=data, headers=h), timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except json.JSONDecodeError:
            return e.code, {}


def twilio(method: str, path: str, form: dict | None = None, *, sid: str, token: str) -> dict:
    auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
    status, out = http(method, f"https://api.twilio.com/2010-04-01/Accounts/{sid}/{path}", headers={"Authorization": f"Basic {auth}"}, form=form)
    if status >= 300:
        raise SystemExit(f"Twilio {path}: HTTP {status} {out.get('message', '')}")
    return out


def preflight(keys: dict[str, str]) -> list[str]:
    """What's missing before setup can run, in words a person can act on."""
    problems = []
    if not shutil.which("fly"):
        problems.append("Install the Fly CLI: https://fly.io/docs/flyctl/install/ , then run `fly auth login`.")
    else:
        try:
            sh("fly", "auth", "whoami")
        except subprocess.CalledProcessError:
            problems.append("Sign in to Fly: run `fly auth login`.")
    missing = [k for k in REQUIRED if not keys.get(k)]
    if missing:
        problems.append(f"Fill in kloru.env (copy kloru.env.example): missing {', '.join(missing)}.")
    if keys.get("TWILIO_ACCOUNT_SID") and keys.get("TWILIO_AUTH_TOKEN"):
        auth = base64.b64encode(f"{keys['TWILIO_ACCOUNT_SID']}:{keys['TWILIO_AUTH_TOKEN']}".encode()).decode()
        if http("GET", f"https://api.twilio.com/2010-04-01/Accounts/{keys['TWILIO_ACCOUNT_SID']}.json", headers={"Authorization": f"Basic {auth}"})[0] != 200:
            problems.append("Twilio rejected TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN: copy them again from console.twilio.com.")
    if keys.get("INKBOX_API_KEY") and http("GET", f"{INKBOX}/imessage/triage-number", headers={"X-API-Key": keys["INKBOX_API_KEY"]})[0] != 200:
        problems.append("Inkbox rejected INKBOX_API_KEY: make a new key in the Inkbox console (an admin key, not an identity key).")
    if keys.get("OPENROUTER_API_KEY") and http("GET", "https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {keys['OPENROUTER_API_KEY']}"})[0] != 200:
        problems.append("OpenRouter rejected OPENROUTER_API_KEY: make a new key at openrouter.ai/keys, and add credit.")
    return problems


# Deploying and updating --------------------------------------------------------------------

# What's running on the machine: calls not yet ended (started in the last two hours, so one that
# crashed doesn't block forever) and requests a worker is doing right now.
BUSY_JS = (
    'const fs=require("fs"),R="/data/instinct/repo",now=Date.now();let calls=0,work=0;'
    'const read=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return undefined}};'
    'try{for(const d of fs.readdirSync(R+"/calls")){const c=read(R+"/calls/"+d+"/call.json");'
    'if(c&&!c.endedAt&&now-Date.parse(c.startedAt)<72e5)calls++}}catch{}'
    'try{for(const f of fs.readdirSync(R+"/issues")){const i=read(R+"/issues/"+f);'
    'if(i&&i.status==="executing"&&!i.purpose)work++}}catch{}'
    'console.log(JSON.stringify({calls,work}))'
)


def git(*args: str) -> str:
    return sh("git", "-C", str(ROOT), *args).strip()


def version() -> str:
    """This checkout's release name: git-<commit>, the image label and the Admin page's version."""
    return f"git-{git('rev-parse', 'HEAD')[:12]}"


def deploy(app: str, config: Path, image: str | None = None) -> bool:
    """Build this checkout (or redeploy an earlier image) and wait for Fly's health checks."""
    if image:
        args = ["fly", "deploy", "-c", str(config), "--image", image]
    else:
        v = version()
        args = ["fly", "deploy", "-c", str(config), "--dockerfile", "deploy/kloru/Dockerfile", "--image-label", v, "--env", f"KLORU_VERSION={v}", "."]
    return subprocess.run(args, cwd=ROOT).returncode == 0


def wait_until_up(app: str, domain: str, tries: int = 40) -> bool:
    for _ in range(tries):
        try:
            with urllib.request.urlopen(f"https://{app}.fly.dev/healthz", timeout=10) as r:
                if r.status == 200:
                    print(f"   up at https://{app}.fly.dev" + ("" if on_fly(domain) else f" (and https://{domain} once DNS is in)"))
                    return True
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(15)
    print(f"   not answering yet: check `fly logs -a {app}`")
    return False


def busy(app: str) -> dict | None:
    r = subprocess.run(["fly", "ssh", "console", "-a", app, "-C", f"node -e '{BUSY_JS}'"], capture_output=True, text=True)
    line = next((l for l in reversed(r.stdout.splitlines()) if l.startswith("{")), "")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def wait_until_idle(app: str, minutes: int = 30) -> bool:
    for i in range(minutes * 2):
        b = busy(app)
        if b is None:
            print("   couldn't see what's running (the machine may be down); updating anyway")
            return True
        if not b["calls"] and not b["work"]:
            return True
        if i == 0:
            print(f"   waiting: {b['calls']} call(s) and {b['work']} request(s) in progress")
        time.sleep(30)
    return False


def releases(app: str) -> list[dict]:
    return [r for r in (fly_json("releases", "-a", app, "--image") or []) if r.get("Status") == "complete" and r.get("ImageRef")]


def configs() -> list[Path]:
    return sorted((ROOT / ".selfhost").glob("*/fly.toml"))


def update(app: str | None, *, now: bool) -> int:
    """Pull the latest Kloru and deploy it; if it doesn't come up, put the previous release back."""
    found = [c for c in configs() if app in (None, c.parent.name)]
    if len(found) != 1:
        names = ", ".join(c.parent.name for c in configs()) or "none"
        raise SystemExit(f"which Kloru? pass --app (set up here: {names})" if found else f"no Kloru set up here for {app or 'this checkout'} (set up here: {names})")
    config = found[0]
    app = config.parent.name
    if git("status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("this checkout has local changes; commit or stash them first (`git stash`), then update")
    before = git("rev-parse", "HEAD")
    print(f"→ pulling the latest Kloru")
    sh("git", "-C", str(ROOT), "pull", "--ff-only")
    after = git("rev-parse", "HEAD")
    history = releases(app)
    running = next((r["ImageRef"].rsplit(":", 1)[-1] for r in history), "")
    if running == version():
        print(f"Already up to date: {app} runs {running}.")
        return 0
    since = running.removeprefix("git-") if running.startswith("git-") else before
    changes = subprocess.run(["git", "-C", str(ROOT), "log", "--oneline", "--no-decorate", f"{since}..{after}"], capture_output=True, text=True).stdout.strip()
    print("  What's new:\n" + ("\n".join(f"   {l}" for l in changes.splitlines()[:30]) or "   (a rebuild of the same code)"))
    if not now:
        print("→ waiting for calls and requests to finish (--now skips this)")
        if not wait_until_idle(app):
            raise SystemExit("still busy after 30 minutes; run it again later, or add --now")
    print(f"→ deploying {version()}")
    if deploy(app, config) and wait_until_up(app, app + ".fly.dev", tries=8):
        print(f"\nUpdated {app} to {version()}.")
        return 0
    previous = history[0]["ImageRef"] if history else None
    if not previous:
        raise SystemExit("the new release didn't come up, and there's no earlier one to go back to; check `fly logs`")
    print(f"→ the new release didn't come up; going back to {previous.rsplit(':', 1)[-1]}")
    deploy(app, config, image=previous)
    wait_until_up(app, app + ".fly.dev", tries=8)
    raise SystemExit(f"Update failed and was rolled back. `fly logs -a {app}` shows why.")


def plan(app: str, region: str, domain: str, owner: Owner, *, number: str | None, area_code: str | None, values: dict[str, str]) -> list[Step]:
    config = ROOT / ".selfhost" / app / "fly.toml"
    voice_url = f"https://{domain}/twilio/voice"
    sid, token = values.get("TWILIO_ACCOUNT_SID", ""), values.get("TWILIO_AUTH_TOKEN", "")
    handle = values.get("INKBOX_AGENT_HANDLE", handle_for(app))
    state: dict[str, str] = {}

    def inkbox_identity():
        key = values.get("INKBOX_API_KEY", "")
        status, out = http("POST", f"{INKBOX}/identities/", headers={"X-API-Key": key}, body={"agent_handle": handle, "display_name": "Kloru", "imessage_enabled": True})
        if status == 409:
            print(f"   @{handle} already exists; using it")
        elif status >= 300:
            raise SystemExit(f"Inkbox identity: HTTP {status} {out}")
        else:
            print(f"   created @{out.get('agent_handle', handle)}")
        status, router = http("GET", f"{INKBOX}/imessage/triage-number", headers={"X-API-Key": key})
        state["text_number"] = router.get("number", "") if status == 200 else ""

    def write_config():
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(render_fly_toml(app, region, domain, state.get("text_number", ""), owner.name, owner.email))

    def our_number() -> str | None:
        """A number an earlier run bought for this Kloru (named "Kloru <app>")."""
        if not (sid and token):
            return None
        got = twilio("GET", f"IncomingPhoneNumbers.json?FriendlyName={urllib.parse.quote(f'Kloru {app}')}", sid=sid, token=token)
        return next((n["phone_number"] for n in got.get("incoming_phone_numbers", [])), None)

    def buy():
        found = twilio("GET", f"AvailablePhoneNumbers/US/Local.json?AreaCode={area_code}&VoiceEnabled=true&SmsEnabled=true&PageSize=1", sid=sid, token=token)
        if not found.get("available_phone_numbers"):
            raise SystemExit(f"no numbers available in area code {area_code}; try a nearby one")
        bought = twilio("POST", "IncomingPhoneNumbers.json", {"PhoneNumber": found["available_phone_numbers"][0]["phone_number"], "FriendlyName": f"Kloru {app}", "VoiceUrl": voice_url, "VoiceMethod": "POST"}, sid=sid, token=token)
        print(f"   bought {bought['phone_number']}: call it to talk to Kloru")

    def point():
        found = twilio("GET", f"IncomingPhoneNumbers.json?PhoneNumber={urllib.parse.quote(number or '')}", sid=sid, token=token)
        if not found.get("incoming_phone_numbers"):
            raise SystemExit(f"{number} isn't a number on your Twilio account")
        twilio("POST", f"IncomingPhoneNumbers/{found['incoming_phone_numbers'][0]['sid']}.json", {"VoiceUrl": voice_url, "VoiceMethod": "POST", "FriendlyName": f"Kloru {app}"}, sid=sid, token=token)

    def certificate():
        if not ok("fly", "certs", "show", domain, "-a", app):
            sh("fly", "certs", "add", domain, "-a", app)
        print("   Add these DNS records where your domain is managed (skip any already there):")
        try:
            ips = json.loads(sh("fly", "ips", "list", "-a", app, "--json"))
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            ips = []
        if domain.count(".") >= 2:
            print(f"     CNAME  {domain.split('.')[0]}  →  {app}.fly.dev   (if your DNS is Cloudflare: DNS only, grey cloud)")
        for ip in ips:
            print(f"     {'AAAA' if ':' in ip.get('Address', '') else 'A'}  {domain}  →  {ip.get('Address')}")

    def volume_exists() -> str | None:
        vols = fly_json("volumes", "list", "-a", app) or []
        return "kloru_data exists" if any(v.get("name") == "kloru_data" for v in vols) else None

    steps = [
        Step("create the Fly app", f"fly apps create {app} (free; the machine is billed once it's deployed)", run=lambda: sh("fly", "apps", "create", app),
             done=lambda: f"{app} exists" if ok("fly", "status", "-a", app) else None),
        Step("create the data volume", f"10 GB volume kloru_data in {region} (about $1.50/month)", costs=True, run=lambda: sh("fly", "volumes", "create", "kloru_data", "-a", app, "-r", region, "-s", "10", "--yes"),
             done=volume_exists),
        Step("create Kloru's iMessage identity", f"@{handle} on Inkbox, and look up the number people text", run=inkbox_identity),
        Step("write your fly.toml", str(config.relative_to(ROOT)), run=write_config),
        Step("stage secrets", f"{len([k for k in values if k not in GENERATED])} keys and your details, {len(GENERATED)} generated (values never printed)", run=lambda: sh("fly", "secrets", "import", "--app", app, "--stage", stdin="".join(f"{k}={v}\n" for k, v in values.items()))),
    ]
    if number:
        steps.append(Step("point your number at Kloru", f"{number} → {voice_url}", run=point))
    else:
        steps.append(Step("buy a phone number", f"a local {area_code} number (about $1.15/month), calls → {voice_url}", costs=True, run=buy,
                          done=lambda: (lambda n: f"{n} was bought for this Kloru" if n else None)(our_number())))
    if not on_fly(domain):
        steps.append(Step("add the TLS certificate", f"fly certs add {domain}, then print the DNS records to add", run=certificate))
    steps += [
        Step("deploy", f"build and start Kloru (shared-cpu-2x, 2 GB: about $15/month)", costs=True, run=lambda: deploy(app, config)),
        Step("check it's up", f"https://{app}.fly.dev/healthz", run=lambda: wait_until_up(app, domain)),
    ]
    return steps


def run_steps(steps: list[Step]) -> None:
    """Each step in turn, skipping what an earlier run already did."""
    for i, s in enumerate(steps, 1):
        already = s.done() if s.done else None
        if already:
            print(f"→ {i}. {s.name}: already done ({already})")
            continue
        print(f"→ {i}. {s.name}")
        if s.run() is False:
            raise SystemExit(f"{s.name} failed; fix what it says above and run this again (finished steps are skipped)")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="only check that the tools and keys are ready")
    ap.add_argument("--domain", help="where Kloru lives, e.g. kloru.example.com")
    ap.add_argument("--app", help="Fly app name (default from the domain)")
    ap.add_argument("--region", default="sjc", help="Fly region near you (default sjc, San Jose)")
    ap.add_argument("--owner-name")
    ap.add_argument("--owner-phone")
    ap.add_argument("--owner-email")
    ap.add_argument("--timezone", default="America/Los_Angeles")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--area-code", help="buy a new local number in this area code")
    g.add_argument("--number", help="use a number your Twilio account already owns")
    ap.add_argument("--env", default=str(ROOT / "kloru.env"), help="your keys (default kloru.env)")
    ap.add_argument("--apply", action="store_true", help="do it (otherwise only print the plan)")
    ap.add_argument("--update", action="store_true", help="pull the latest Kloru and deploy it, rolled back if it doesn't come up")
    ap.add_argument("--now", action="store_true", help="with --update: don't wait for calls and requests to finish")
    a = ap.parse_args(argv)
    if a.update:
        return update(a.app, now=a.now)
    keys = read_env(Path(a.env))

    problems = preflight(keys)
    if a.check:
        print("\n".join(f"- {p}" for p in problems) or "Ready: Fly is signed in and the required keys work.")
        missing = [k for k in OPTIONAL if not keys.get(k)]
        if missing:
            print(f"Optional, not set: {', '.join(missing)}")
        return 1 if problems else 0
    need = [n for n, v in (("--domain", a.domain), ("--owner-name", a.owner_name), ("--owner-phone", a.owner_phone), ("--owner-email", a.owner_email)) if not v]
    if need or not (a.area_code or a.number):
        raise SystemExit(f"missing {', '.join(need + ([] if a.area_code or a.number else ['--area-code or --number']))}")
    if problems:
        print("Not ready yet:\n" + "\n".join(f"- {p}" for p in problems))
        return 1

    domain = check_domain(a.domain)
    app = a.app or default_app(domain)
    owner = Owner(a.owner_name, a.owner_phone, a.owner_email, a.timezone)
    e164(owner.phone)
    generated = load_or_generate(app) if a.apply else generate_secrets()
    values = secrets_for(owner, keys, generated, handle_for(app))
    steps = plan(app, a.region, domain, owner, number=a.number and e164(a.number), area_code=a.area_code, values=values)
    print(f"Your Kloru: app {app} in {a.region}, https://{domain}, owner {owner.name} {e164(owner.phone)}")
    for i, s in enumerate(steps, 1):
        print(f"{i:2}. {s.name}{'  [costs money]' if s.costs else ''}\n    {s.detail}")
    if not a.apply:
        print("   (steps already done are skipped when it runs)")
    print("Then, by you: add the DNS records it prints; for texts by SMS, register the number for A2P in Twilio (iMessage and calls work without it).")
    if not a.apply:
        print("\nNothing was done. Add --apply to run these steps.")
        return 0
    run_steps(steps)
    print(f"\nDone. Sign in at https://{domain} with {e164(owner.phone)}; the Get started page walks you through the rest.")
    print(f"Generated secrets are in {generated_path(app).relative_to(ROOT)}: keep a copy somewhere safe (the backup and vault keys can't be recovered).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
