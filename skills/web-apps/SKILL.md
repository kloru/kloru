---
name: web-apps
description: Make an app people use from their phones at a Kloru link, such as a shared grocery list, a chore chart, a sign-up or RSVP form, a tracker, a map, a dashboard or a simple game. Use when someone asks for something the family fills in or ticks off themselves, or asks to change or fix an app you made. Write one HTML file with app_create, give it a server with app_server when it needs a key or code of its own, try it with app_test, read or fill its data with app_data, send the link, and change it later with app_update at the same link. Also for QA trying an app an engineer made.
---

# Web apps

An app is one HTML file you write with `app_create`. Kloru hosts it at a link, keeps its data, and
shows it to the family signed in. When the page isn't enough, `app_server` gives it code that runs
on Kloru's machine. There is nothing to build or deploy, and nowhere else to host it. Anyone's request can make one.

A page (`artifact_create`) is for a result people read. An app is for something they fill in or tick
off themselves.

## Write it

- One file: your markup, `<style>` and `<script>`. Plain HTML and ES modules; no build step.
- The app can use the web over https: a library, a stylesheet, fonts, images, map tiles, `fetch`
  to a public API that allows any origin. Load a library by URL with an exact version, from
  cdn.jsdelivr.net or unpkg.com: `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`.
- Picks that work here: a map is Leaflet with OpenStreetMap tiles
  (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, with its attribution); a chart is Chart.js;
  routes, places and weather come from APIs that need no key (OSRM, Nominatim, Open-Meteo). Use
  something else when these don't fit.
- A link out needs `target="_blank"`; the app can't move the page it sits in.
- `localStorage` and cookies don't work in the page. Keep what must last in `kloru`.
- Anything in the page is public to whoever opens it. A key, a call to a service that needs one, a
  webhook, a sign-in with another service, scheduled work: those go in the app's server.
- Phones first. Most people open the link from a text. Lay it out for a narrow screen, with text of
  16px or more (smaller makes iPhones zoom in on inputs), buttons and rows a thumb can hit (44px
  tall), no sideways scrolling, and the main action reachable without scrolling. Follow light or
  dark with `prefers-color-scheme`. It should still look right on a laptop.
- Keep it plain: the title, the thing to do, the list or the map. No sign-in screen; Kloru knows who is there.

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
nothing else is stored.

## Give it a server

`app_server` puts code on Kloru's machine, starts it, and says whether it came up. It starts at
`server.js`:

    export default async (request, kloru) => {
      const url = new URL(request.url);
      if (url.pathname === "/tiles") return fetch(`https://maps.example/tiles?key=${kloru.secrets["cleo-maps-key"]}`);
      return { hello: kloru.user(request)?.name };
    };

- Return a `Response`, or anything else to send it as JSON. Files under `public/` are served as they are.
- The page calls it with `await kloru.fetch("/tiles")` (like `fetch`; a plain object as `body` goes
  as JSON). `await kloru.link(path)` is an address for an `<img>` or a download, and
  `await kloru.socket(path)` a WebSocket.
- `kloru.user(request)` is `{ name, id, family }` for whoever is using the app, or null. Only
  `/public/...` is open to the world, as nobody: a webhook goes there, at `<the app's link>/api/public/...`.
- A key lives in the vault. Save one you got with `vault_save_api_key`, name it in `secrets`, and
  read it as `kloru.secrets["its-name"]`. Never write it in a file.
- Also there: `kloru.data.list/put/remove` (the page's records), `kloru.db` (its own SQLite),
  `kloru.dir` (a folder for files), `kloru.every("15m", fn)`, `kloru.tell("words")` to bring
  something to the family through Kloru, and npm `packages`.
- `export function listen(server, kloru)` hands you the Node server, for WebSockets or express.
- Try it with `app_call` before the page uses it. When it doesn't answer, `app_logs` shows what it
  printed and threw. `scratch: true` is the copy `app_test` and QA use, on scratch data.

## Its data, from your side

`app_data` reads and changes the same records the page does: `list` (what's there), `put` (add, or
replace by `id`), `remove`.

- A list someone gave you ("put these 17 things on it") goes in with `app_data` `put`, once. Never
  write their items into the script: code that adds them when the page loads adds them again after
  someone removes them.
- When something is reported wrong ("deleted items come back"), `list` what the app really holds
  before changing code. Old records may lack fields newer code expects.
- `scratch: true` is the copy `app_test` runs on. `clear` it for a fresh start, or `put` records
  shaped like the real ones to see how the page handles them.

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

Each `app_test` opens the app fresh, like someone coming back to it. So check that a change stuck
in a second call: what you removed is still gone, what you ticked is still ticked.

For a bug someone reported, make it happen in `app_test` first. A fix you haven't seen fail before
and pass after isn't a fix yet.

## QA

When you say an app is ready, QA uses it on a phone before anyone gets the link, and sends back
what stops people using it. As QA: `clear` the scratch copy, then do what the request asked the
way the family would, with a few records in it: add, change, tick, remove, come back (a second
`app_test`) and look again. Then `app_verdict`. For each bug give the steps, what happened, and
what should have. An app that works but could look better is usable.

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
- Do not put a key or a password in the page or in a server file; it goes in the vault. Do not send what people entered to another site unless the request is for exactly that.
- Do not put someone's private details (address, mail, calendar) in an app unless they asked for exactly that; the whole family sees it.
- Do not open an app to guests unless the request calls for it.
- Do not rename a collection or clear data to make a change easier.
