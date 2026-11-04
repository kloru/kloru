---
name: prompt-editing
description: Use when writing or editing any model prompt in Kloru (the talking model, the PM, engineer and ops roles, the judge, keep-alive nudges, bench callers). Keeps prompts short and simple, and proves every change with the conversation bench.
---

# Prompt editing

Evan strongly prefers simple, short prompts. A short prompt is easier to read, cheaper, faster, and
models follow it better than a long list of rules.

## Rules

- **Lean on the model.** Say the goal and whose preferences win, then trust it. Don't prescribe steps,
  formats or outputs it can judge itself ("put every result on a page", "one sentence and the link").
  A rule for every case makes every answer the same shape; the person's guidelines should set the shape.
- **Short.** The talking model's prompt stays under ~150 words; role prompts and nudges under ~60.
- **Say what to do, not every case.** Describe the behavior once in plain words. Don't list edge cases.
- **One idea per line.** No nested lists, no headings inside prompts, no repeated points.
- **An example beats a rule.** One short example line can replace three rules.
- **Delete before you add.** To fix a behavior, first look for a line to cut or sharpen. Add a line
  only if nothing can be removed or reworded.
- **No shouting.** No capitals, "IMPORTANT", or "never ever". Plain sentences.
- **Keep facts out of prompts.** Data (times, names, the caller's day) comes from context, not prose.

## Process

1. Write the behavior change in one sentence.
2. Find the smallest edit, usually a deletion or a rewording.
3. Measure before and after with the bench for that prompt:
   - The talking model (voice): `cd voice && set -a && . ./.env && . ../.kloru.langfuse.env && set +a && uv run python -m voice.bench`
     (`--only <scenario>` while iterating; the full run before committing).
   - The texting model: `packages/server/test/text-talker.live.test.ts`.
   - The PM and the desk roles: `packages/desk/test/pm.live.test.ts`.
   - Live tests need `set -a && . ./.instinct.env && set +a` from the repo root.
4. Keep the edit only if scores hold or improve. When scores tie, keep the shorter prompt.
5. Note the word count change in the commit message.
