---
name: travel
description: Search and book flights and hotels. Use when the owner mentions a trip, a flight, a hotel, a check-in, or wants travel options compared. Search and book in Kloru's browser, compare two or three options with full totals, book what they asked for, set check-in reminders with schedules, and pay with the person's saved card.
---

# Travel

Travel is where mistakes cost real money: get the details right and show totals. What they asked
for, book; a choice that's still theirs (which flight), ask.

## Gather

Dates (fixed or flexible), origin and destination, number of travellers, cabin
or hotel class, budget, loyalty programmes, and constraints from memory (aisle
seat, no red-eyes, hotel near the venue). Ask for what is missing, one question
per text. Save new preferences with `memory_write`.

## Search

Use the browser (skill `browser`). Flights: Google Flights
(google.com/travel/flights) for the overview, then the airline's own site for
the fare and bags. Hotels: Google Hotels for the overview, then the hotel's own
site and one aggregator for price. `web_search` is fine for background (visa
rules, airport transfer time) but prices come from the booking pages.

For each option record: carrier or property, times or dates, duration and stops,
fare class, what is included (bags, seat, breakfast, cancellation), and the
total with taxes and fees. Zoom on the total; sites hide fees until late.

## Compare

Text 2 or 3 options in one message. Lead with the total. Say the trade-off in a
phrase. Recommend one and say why in one sentence.

Agent: Three options for Boston to SFO, Oct 20 to 24. JetBlue nonstop out 7:10am
back 4:30pm, $412 total with a carry-on. United nonstop out 9am back 6pm, $468,
checked bag included. Delta one stop, $355 but adds three hours each way. I'd
take JetBlue. Want me to book it?

## Book

1. They asked for a specific booking (or picked an option): book it; that's the yes. Parking,
   a seat, a hotel they named. When it's still a choice (which flight), the options text asks.
2. Fill passenger details from memory only if the owner has stored
   them there and told you to use them. Dates of birth, passport numbers and
   loyalty numbers saved in the vault go in by reference (skill `browser`);
   never ask the owner to text them to you.
3. At the payment step, pay with `browser_pay` and the owner's saved card. If
   it says no (a card limit), stop and tell the owner. Do not retry.
4. Read the confirmation page. Zoom on the record locator, dates and total.
   Save a screenshot to the workspace (`workspace/travel/<trip>/confirmation.png`).

## After booking

- Calendar: create events for each flight (departure to arrival, airport
  terminals in the location) and the hotel stay. Include the record locator.
- `schedule_create` a one-shot reminder 24 hours before each departure with the
  prompt "Check in for JetBlue BOS-SFO Oct 20, locator ABC123, then text the
  owner the boarding pass status." Online check-in itself happens when that
  fires, again in the browser, with the person's saved login.
- `journal_append` the booking. The approval you got records the spend in the
  audit; mention merchant and total in the journal line too.
- Text the owner: what was booked, total, locator, and that reminders are set.

## Changes and cancellations

Find the fare rules first (airline site, "manage booking"). Tell the owner the
fee and the refund form (cash, credit). Change only after a yes. Cancellation
within 24 hours of purchase is often free in the US; mention it when relevant.

## Do not

- Do not book something they didn't ask for, or a total well above what they expected.
- Do not type card numbers or passport numbers; cards go in only through `browser_pay`.
- Do not quote a fare without the total including taxes and the bag you know
  the owner needs.
- Do not hold two bookings for the same trip.
