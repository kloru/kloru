---
name: purchases
description: Buy things for the owner within the spend policy. Use when the owner asks to order, buy, reorder, or find the best price for a product, or when a trusted person asks for a purchase on the owner's behalf. Compare prices, check a new merchant, buy with the person's card from the vault, and record the spend. Their request is the yes.
---

# Purchases

Money moves here, so the policy guard is strict. Read the spend policy
(`perActionUsd`, `perDayUsd`, `askAbove`, `neverWithoutAsk`, merchant lists)
as the rules you work within. When unsure, ask.

## Gather

What exactly, quantity, acceptable substitutes, delivery deadline, budget,
preferred merchants from memory (`memory_read`). Reorders: check the journal
and memory for the last order and offer to repeat it.

## Compare

1. `web_search` the product plus "price". `web_fetch` two or three merchant
   pages. Prefer merchants the owner has used (memory) and `allowedMerchants`.
   Skip `blockedMerchants` without comment unless asked.
2. Record for each: price, shipping, tax if shown, delivery date, return
   policy. The number you report is the total to the door.
3. One clear best option: buy it. Two close ones that differ in a way they'd care about: text both in
   one message, lead with the total, say the trade-off, recommend one.

Agent: Two options for the Anker 737 power bank. Amazon $89.99 with free
delivery Thursday, easy returns. Anker direct $79.99 with code, ships in 5 to 7
days. I'd go Amazon for Thursday unless the ten dollars matters. Which?

## Approval

- The person asked for it: that's the yes. Buy it, then tell them what, where and the total. The
  card's own limits hold; if it says no, tell them the limit.
- Ask first only when there's a real choice they'd want to make (two quite different options), or
  the total is well above what they'd expect.
- Someone else asked for the owner's money: the owner is asked for you, and their yes is noted on
  the issue.

## Checkout

1. New merchant: check it first (skill `buying-safely`).
2. Open the site in the browser (skill `browser`). Add the exact item and
   quantity, and read the cart line back: price, quantity, total.
3. Log in with the person's saved login, or sign up with `vault_save_login`.
4. Fill shipping from memory only if the person stored an address and said you
   may use it. Confirm the address on the page.
5. Pay with `browser_pay` and the person's card from `vault_list`, giving the
   merchant, the total and the one-line check. The card's own limits hold in
   code; if it says no, tell the person the limit.
6. Read the confirmation page: order number and total.

## Record

- The approval you obtained is what the audit uses for spend. In addition,
  `journal_append` one line: date, merchant, item, total, order number.
- `memory_write` any new stable fact: a preferred merchant, a size, a brand to
  avoid.
- Text the owner: what, where, total, delivery date, order number.

## For other people

A partner asking for a purchase ("order Maria more coffee pods") is `purchase`
at `ask`: build the comparison, then the approval goes to the owner, not the
requester. Tell the requester you are checking. Family, friends and contacts
cannot trigger purchases at all; decline kindly and offer to pass the message.

## Do not

- Do not type card numbers, CVVs or gift card codes; cards go in only through `browser_pay`.
- Do not change saved payment methods or addresses on a merchant account.
- Do not place an order when the total differs from what the owner approved.
- Do not split one purchase into several to stay under a limit.
