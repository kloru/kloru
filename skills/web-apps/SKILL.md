---
name: web-apps
description: Make a small app people use from their phones at a Kloru link, such as a shared grocery list, a chore chart, a sign-up or RSVP form, a tracker or a simple game. Use when someone asks for something the family fills in or ticks off themselves, or asks to change or fix an app you made. Write one HTML file with app_create, try it with app_test, send the link, and change it later with app_update at the same link.
---

# Web apps

An app is one HTML file you write with `app_create`. Kloru hosts it at a link, keeps its data, and
shows it to the family signed in. There is nothing to build or deploy. Anyone's request can make one.

A page (`artifact_create`) is for a result people read. An app is for something they fill in or tick
off themselves.

## Write it

- One file: markup, `<style>` and `<script>` inline. Nothing loads from another address (no CDN, no
  fonts, no images by URL), and the app can't call the network. Use emoji or inline SVG for pictures.
- Phones first. Most people open the link from a text. Lay it out for a narrow screen, with text of
  16px or more (smaller makes iPhones zoom in on inputs), buttons and rows a thumb can hit (44px
  tall), no sideways scrolling, and the main action reachable without scrolling. Follow light or
  dark with `prefers-color-scheme`. It should still look right on a laptop.
- Keep it plain: the title, the thing to do, the list. No sign-in screen; Kloru knows who is there.

## Keep its data

`kloru` is already there when your script runs:

- `await kloru.list("items")` gives every record in a collection, oldest first.
- `await kloru.put("items", { name: "Milk", done: false })` adds a record and returns it with `id`,
  `by` (who added it) and `at`. With an `id` it replaces that record: `kloru.put("items", { ...item, done: true })`.
- `await kloru.remove("items", id)`.
- `kloru.onChange(fn)` calls `fn` when anyone changes the data. Load and draw again there, so two
  phones stay in step.
- `kloru.me` is `{ name }`, or null for a guest.

Draw from `kloru.list`, not from a copy you keep. Show a short message when a save fails (the
promise rejects with words people can read). Put text on the page with `textContent`, never
`innerHTML`, since other people typed it. A record holds up to 16 KB and an app 5,000 records;
nothing else is stored (no `localStorage`, no cookies).

## Who can use it

The family, signed in, by default. Ask for guests only when the request needs them (`visitors`):
`add` lets anyone with the link add entries and see only their own (an RSVP form); `all` lets them
see and change everything (a potluck sign-up). Say in your result when a link works without signing in.

## Try it before you send it

`app_create` checks only that the script parses. With `app_test`, use the app the way a person
would, in a phone-sized browser on scratch data: add something, tick it off, remove it, and read
back what the page shows.

    await app.getByPlaceholder("Add an item").fill("Milk");
    await app.getByRole("button", { name: "Add" }).click();
    return await app.locator("body").ariaSnapshot();

Check that nothing is wider than the screen:
`return await app.locator("html").evaluate((e) => e.scrollWidth <= e.clientWidth)`.
Fix what's wrong with `app_update` and try again. The result lists script errors the app threw.
Without `app_test`, read the file once more against this page before you send the link.

## Change it

A follow-up ("add a quantity field") changes the same app: `app_read` it, then `app_update` with
`replace` for a small change or `html` for a new file. The link stays the same and open phones
reload by themselves. Keep collection names and fields, so what people entered stays; make new
code cope with old records that lack a new field. `app_read` also lists errors people's browsers
reported: fix those first.

## Tell them

One or two lines and the link: what it is, and who can use it.

Agent: Your grocery list is ready: https://kloru.com/a/Qm9v... Anyone in the family can add items and tick them off.

## Do not

- Do not ask for passwords, card numbers or other sensitive details in an app.
- Do not put someone's private details (address, mail, calendar) in an app unless they asked for exactly that; the whole family sees it.
- Do not open an app to guests unless the request calls for it.
- Do not rename a collection or clear data to make a change easier.
