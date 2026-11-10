---
name: no-real-people
description: Use whenever you write or edit anything that lands in the repo or on GitHub and contains a person, phone number or email - tests, fixtures, bench scenarios, prompts, docs, examples, config defaults, commit messages, issues and PRs. No real names, phone numbers or emails; use the made-up cast and reserved ranges below.
---

# No real people in the repo

Evan's rule (2026-11-10): the repo never holds a real name, phone number or email. Kloru is
heading for a public repo, and git history and issues can't be cleaned up after the fact. The
secret scan (gitleaks) finds keys, not people, so this one is on whoever writes the line.

It covers everything that is committed or posted: code, tests, fixtures, bench scenarios, prompts,
docs, skills, config such as `fly.toml`, commit messages, issues and PR text.

## What counts as real

- **Names:** Evan, Cara, their family, friends, callers, anyone from a real call, email or
  calendar, and real businesses a family dealt with (a daycare, an advisor, a doctor).
- **Phone numbers:** any number that could ring, including Kloru's own lines and callers' numbers.
- **Emails:** any address at a domain someone owns, including `gmail.com` and guessable ones like
  `evan@gmail.com`.
- **The details around them:** home city, trips, appointments, policy amounts, call IDs and
  message text copied from real traffic. Rewrite the scenario; don't paste it.

## What to use instead

- **Names:** the made-up Vega family. Ezra Vega (owner), Cleo Vega (partner), Nora (child, "Noni"),
  Dad Vega (grandparent). They live in Portland, in Maplewood; Nora goes to Little Pines. Outsiders:
  Dr. Lee, Jordan Kim, "Maplewood Dental".
- **Phone numbers:** only the reserved fiction range, `+1 NXX 555 0100` to `0199`, for example
  `+14155550190` for Ezra and `+14155550191` for Cleo.
- **Emails:** only reserved domains: `example.com`, `example.org`, `example.net`, or anything
  ending in `.example` (`ezra@work.example.com`, `office@maplewood.example`).
- **Kloru's own addresses and numbers:** read them from config or env. In tests use a 555 number
  and `vegas@mail.kloru.com`. The production `fly.toml` carries the real text line; nothing else does.
- **Other identifiers:** invented call IDs (`CA` plus zeros), invented handles (`kloru-vegas`).

Fine as they are: Kloru's public contact addresses (`support@kloru.com`, `privacy@kloru.com`,
`legal@kloru.com`), service addresses the code or docs depend on (Inkbox and AtomicMail mailboxes,
`agent-spend@stripe.com`), and Evan's name where he signs his own work (the site's letter, these
skills).

## When a bug came from a real call

Describe what happened with the cast above: "Cleo asked for start and end alerts and got one."
Keep the real call ID and names in Langfuse or your private notes, not in the test, the commit or
the issue.

## Before you commit

Run this over what you staged, and fix every line it prints:

```sh
git diff --cached -U0 | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -nE '\+1[0-9]{10}|\(?[2-9][0-9]{2}\)?[ -][0-9]{3}-[0-9]{4}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' \
  | grep -vE '555-?01[0-9]{2}|@([a-z0-9-]+\.)*example(\.(com|org|net))?\b|@(mail\.)?kloru\.com|@(inkbox\.ai|inkboxmail\.com|atomicmail\.ai|stripe\.com)'
```

The grep can't see names. Read the diff for those yourself.

If you find real data that is already committed, replace it in the same change and tell Evan, so
he knows it is in the history.
