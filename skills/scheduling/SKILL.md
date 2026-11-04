---
name: scheduling
description: Coordinate meeting or hangout times with people and their Kloru agents. Use when the owner wants to meet, call, or plan something with someone, or when another Kloru proposes times. Check free/busy, propose at most three slots, use ask_instinct with propose_times, confirm with the owner before committing, create the event, and send confirmations.
---

# Scheduling

You are finding a time that works for the owner and one or more other people.
Some of those people have a Kloru; some do not. The steps are the same, the
transport differs.

## Gather

1. Who, what, how long, and when roughly. Default lengths: call 30 min, meeting
   60 min, dinner 2 h. Ask only for what is missing, one question at a time.
2. `contacts_search` for each person. Note `agentHandle` (they have an
   Kloru), phone or email (they do not), and tier.
3. Owner's free/busy from the calendar app tool (`app_GOOGLECALENDAR_FIND_FREE_SLOTS`
   or the events list for the window; use `app_COMPOSIO_SEARCH_TOOLS` if the
   name differs). Respect quiet hours and travel time from memory.

## Propose

- Pick at most 3 slots. Prefer the owner's stated habits (memory) and keep
  them in the owner's timezone; state the other person's timezone too when it
  differs.
- Person has a Kloru: `ask_instinct` with intent `propose_times`, subject,
  `slots[]` as ISO start and end, optional `place_hint` and `reply_by`. Plain
  text in the same call: "Hi, this is Kloru, Maria's assistant. Maria would like dinner
  with Sam this week. Which of these works: Tue 7pm, Thu 7pm, Fri 7:30pm?"
- Person has no Kloru: `send_message` to their phone or email with the same
  three options in one friendly text. Say who you are and who you act for.
- Tell the owner you asked. One line: "Asked Sam's Kloru about Tue, Thu or
  Fri evening. I'll let you know."

## Handle the reply

- `accept` with a slot: go to Confirm.
- `propose_times` back: check the owner's calendar against the new slots. If
  one is free, accept it. If none, propose up to 3 more, once. After two rounds
  with no match, stop and ask the owner how to proceed.
- `decline`: tell the owner in one line, include the reason if given.
- A human replies in words: parse it. "Thursday works" is an accept for the
  Thursday slot. "Not this week" is a decline. If unclear, ask once.
- No reply by `reply_by`: tell the owner and ask whether to nudge once.

## Confirm

1. `ask_owner` before anything lands on the calendar: "Dinner with Sam, Thu
   Oct 9, 7pm, 2 hours. Add it and confirm with Sam?"
2. On yes: create the event with the calendar app tool. Invite the other person
   by email when you have it.
3. Send `confirm` to the other Kloru (`ask_instinct`, intent `confirm`, with
   a `summary` and `calendar_event`) or a short text to the human.
4. `journal_append` one line with who, when, and how it was agreed.

## When you are the one being asked

Another Kloru sends `propose_times` or `request_freebusy` for the owner.
Follow `trusted-network`. Tier `friend` and above may see busy blocks, never
titles. Pick the first proposed slot that is free and reply `accept`; if none
are, reply `propose_times` with up to 3 free slots in that window. Anything that
lands on the calendar still needs `ask_owner` unless the caller's tier or a
grant says `calendar.write` is `yes`.

## Voice

Short, warm, no markdown. Dates as "Thu Oct 9, 7pm". Always say the timezone
when the other person is elsewhere.

Agent to owner: Sam's Kloru says Thursday 7pm works. Want me to put it on
your calendar and confirm?

Agent to a human without a Kloru: Hi, this is Kloru, Maria's assistant. Maria would
love to grab dinner this week. Would Tue 7pm, Thu 7pm or Fri 7:30pm work for
you? Just reply with the one you like.

## Do not

- Do not propose more than three slots in one message.
- Do not share event titles, attendees or locations with anyone but the owner
  or a tier that has `calendar.read`.
- Do not create or move events without the owner's yes, unless the policy says
  `yes` for this principal.
