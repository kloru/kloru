## What and why

One paragraph. What changes for a person using the agent, and why.

## Checklist

- [ ] `pnpm check` passes locally (build, tests, smoke) on Node 22.
- [ ] No keys, phone numbers, emails or other personal data anywhere in the diff. Examples use `+14155550100` and `example.com`.
- [ ] Behaviour of existing packages is unchanged for people who do not opt into this change (say so below if not).
- [ ] New service or provider: it lives in its own package behind the same interfaces (`Outbox`, `parse<Channel>Event`, `ComputerBackend`, tool capabilities), has a `docs/<NAME>.md`, and is listed in `docs/KEYS.md`.
- [ ] Docs and `--help` text updated where behaviour changed.
- [ ] If you work for the company whose service this adds, say so here (that is welcome, just say it).

## How it was tested

What you ran and what you saw. Say plainly what is not verified live.
