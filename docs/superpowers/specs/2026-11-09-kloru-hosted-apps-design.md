# Kloru-hosted apps

Design for [issue #43](https://github.com/kloru/kloru/issues/43), 2026-11-09.

## Goal

When a request needs state that people change themselves (a shared grocery list, an RSVP form),
Kloru makes a small web app instead of a page. Family members use it from their phones, a
follow-up changes the same app at the same link, and it is private to the family unless the app is
meant for guests.

Success is the issue's acceptance list:

- "Make us a shared grocery list" produces an app whose items family members add and check off from
  their phones, and the text back is a short summary with the link.
- "Add a quantity field to the grocery list" updates the same app at the same URL.
- Someone who isn't signed in can't see a family app's data.
- "Summarize my week" still produces a page.
- Apps show up on the website next to pages.

## Approach

Kloru hosts the apps itself. An app is one HTML file (markup, style and script) that an engineer
writes with a tool call, plus a data store Kloru provides. There is no build, no deploy, no outside
account and no shell, so a member's request can make an app, and a self-hosted install needs no
setup.

Considered and set aside:

- **Ample** (`packages/ample`, from the upstream project): the engineer must write a server, design
  tables, deploy and read build logs; deploying needs `files.write`, which is owner-only because
  `bash` is a real shell; Ample URLs are public and nothing can put family sign-in in front of
  them. It stays in the tree, off, as the later path for apps that need their own server.
- **Vercel, Netlify, Cloudflare:** the same work as Ample plus a new integration.
- **Docker Cloud Sandboxes:** a good place to build an app safely, not a place to host one
  (sandboxes expire within 24 hours and a published port has no sign-in). Not needed while apps
  have no build step. If server apps are added later, builds run in a sandbox.

## An app is an artifact

`Artifact` (`packages/desk/src/types.ts`) gains:

```ts
/** A page (markdown) or an app (one HTML file with a data store). Missing means page. */
kind?: "page" | "app";
/** An app's file. Pages keep `markdown`; an app's `markdown` is "". */
html?: string;
/** What someone with the link who isn't signed in may do with an app. Missing means none. */
visitors?: "none" | "add" | "all";
```

`ArtifactVersion` gains `html?` and `visitors?`. Everything else is shared with pages: the
22-character id, `kloru.com/a/<id>`, the versions file, take-down on `/admin/desk`,
`issue.artifact`, `artifact_find`, and the PM's `continues` path for follow-ups. That is what
keeps a follow-up on the same link.

One rule differs from pages: any family member's request may update an app, not only its maker's or
an owner's, because an app is shared by the family. `Desk.mayRead` stays as it is for pages.

## Engineer tools

In a new `packages/desk/src/apps.ts`, registered beside `artifactTools`. Like the page tools they
need no capability, and the issue comes from the worker's conversation, never from arguments.

| Tool | Parameters | Result |
|---|---|---|
| `app_create` | `title`, `html`, `visitors?` | The link |
| `app_update` | `id`, then `html` (whole file) or `replace: { old, new }` (one exact, unique match), `title?`, `visitors?` | The link and version |
| `app_read` | `id` | The file, its version, `visitors`, and errors people's browsers reported since the last version |

`Desk.publishApp` and `Desk.updateApp` mirror `publishArtifact` and `updateArtifact`, returning
`Result`. Both refuse an empty file, a file over 512,000 characters, and a file whose inline
scripts don't parse (checked with `node:vm`'s `Script`, which compiles without running); the
error names the line so the engineer can fix it. `artifact_find` and `artifact_read` also return
apps (`artifact_read` points to `app_read` for one).

## How an app runs

Two routes in `packages/web/src/server.ts`:

- `GET /a/<id>` serves the **shell** when the artifact is an app: a Kloru page with the title and
  a full-height frame. Its script is a static asset (`app-shell.js`), so the existing `PAGE_CSP`
  holds.
- `GET /a/<id>/app` serves the **frame**: the app's HTML with Kloru's client script put first.

The frame's headers are the isolation:

```
Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none';
  form-action 'none'
```

`allow-forms` is there only so a form's `submit` event fires for the app's script (a sandbox
without it drops the event); `form-action 'none'` still stops any real post.

`sandbox` without `allow-same-origin` gives the app an opaque origin: no kloru.com cookies, no
storage, and no same-origin requests. `default-src 'none'` with no `connect-src` means it can
make no network request at all, and it can't post a form, open a window or navigate the top page.
The header applies even when the frame URL is opened directly. So an app can't reach `/vault`,
another app, or the internet, and family data can't leave. The cost: no outside libraries, fonts or
images; the engineer writes plain HTML, CSS and script.

The app's only channel is `postMessage` to the shell. The shell accepts messages only from its own
frame's window, and turns each into a request to that app's data routes.

## Data store

The client script gives the app:

```js
kloru.me                         // { name } of the signed-in person, or null for a visitor
await kloru.list("items")        // every record in a collection, oldest first
await kloru.put("items", record) // add; with record.id, replace. Returns the stored record
await kloru.remove("items", id)
kloru.onChange(() => { ... })    // called when anyone changed anything
```

A record is any JSON object. The store adds `id`, `by` (the person's name, or "visitor") and `at`.
Collections are created by use and there is no schema, so adding a field needs no migration.

The website owns the store: `packages/web/src/app-store.ts`, a `node:sqlite` database at
`<web data>/apps.db` (`/data/kloru/apps.db` in production), in the style of
`packages/server/src/metrics-db.ts`.

```sql
CREATE TABLE records (app TEXT, collection TEXT, id TEXT, data TEXT, by_who TEXT, at TEXT,
  PRIMARY KEY (app, collection, id));
CREATE TABLE app_rev (app TEXT PRIMARY KEY, rev INTEGER);
CREATE TABLE app_errors (app TEXT, version INTEGER, at TEXT, message TEXT);
```

Routes, all under the app's id and all checked for access (next section):

| Route | Does |
|---|---|
| `GET /a/<id>/data/<collection>` | The collection's records, and the app's `rev` |
| `GET /a/<id>/data?rev=<n>` | The current `rev` (the shell polls this every 2 s while visible; a change calls `onChange`) |
| `PUT /a/<id>/data/<collection>` | Add or replace a record; bumps `rev` |
| `DELETE /a/<id>/data/<collection>/<record>` | Remove; bumps `rev` |
| `POST /a/<id>/errors` | Record a script error from the frame (deduplicated, at most 20 kept per version) |

Limits, refused with a plain message the app can show: 16 KB per record, 5,000 records per app,
collection names `^[a-z0-9_-]{1,40}$`. Writes carry a key served in the shell (the session's CSRF
token for family, a per-app key like `editKey` for visitors), so another site can't write for you.

Taking an app down (`/admin/desk`) stops every route with 410; its records stay in the database.

## Who can use an app

The shell, frame and data routes share one check, a pure function
`appAccess(app, user, visitor) → "family" | "visitor" | "sign-in"`:

| `visitors` | Signed-in family | Someone else with the link |
|---|---|---|
| `none` (default) | everything | sent to sign in, then back to the app |
| `add` | everything | may add records, and list, replace and remove only their own |
| `all` | everything | everything |

Family means what `allowed()` already means. A visitor is recognised by a random token the shell
keeps in the browser's storage for kloru.com (the frame has none); records store its hash to tell
"their own". Visitor writes are limited to 30 a minute per address.

## Catching broken apps

A model can ship an app that looks right and fails on use (the upstream Ample run did). Two
checks, both plumbing:

- The syntax check at `app_create` and `app_update`.
- The client script catches uncaught errors and rejected promises in the frame and reports them
  through the shell. `app_read` and the result of `app_update` show them, so the next follow-up
  starts from what actually broke.

## Phones first

Most people open an app from a text, so apps are built for a phone: a narrow layout, 16px text,
thumb-sized controls, no sideways scrolling, light and dark. This is guidance in the `web-apps`
skill (and "phone-first" in the tool's own description), not a check in code; the frame adds a
viewport tag so an app that forgets one still lays out at phone width.

## Trying an app before sending it

The engineer can use what it built before it texts the link.

- **A test link.** Each app has a random `testKey`, kept in the artifact. `<link>?test=<key>`
  opens the same app as "Test" on a scratch copy of its data (`<id>~test`), with no sign-in. The
  browser doing the testing may be Steel's, a third party, so it never sees or changes what the
  family entered. Script errors from a test are still recorded against the app's version.
- **`app_test {id, code}`.** Opens the test link in a phone-sized browser (430 × 860, touch),
  loads it fresh, and runs the engineer's Playwright code with `app` (the app's frame) and
  `page`. The result is what the code returned, console output, and the script errors the app
  threw. It runs in the same env-less child process as `browser_run`.
- **A throwaway browser.** `browser_run` is the owner's (`computer.use`): it has their profile
  and sign-ins. `app_test` needs no capability, so any family member's request can test its
  app, and it gets none of that: a browser with no profile (a Steel session without
  `persistProfile`, or local Chromium on a temporary directory), no vault, no other tabs, and
  every request off the app's own site is blocked. It closes with the task.
- The tool exists only where a browser does (Steel or Chromium). Without it the skill says to
  re-read the file instead.

## Listing

A new signed-in page, `/pages`, open to members as well as owners: the person's own pages and
every family app, newest first, each with its link and kind. The admin "Pages" section on
`/admin/desk` gains a kind column. The caller's brief already lists their recent pages; apps
appear there with "(app)" after the title.

## Page or app

Behaviour comes from guidelines, not code (`.claude/skills/guidelines-not-rules`):

- The engineer prompt's page sentence becomes: "A page (artifact_create) is for results too long
  for a text; an app (app_create) is for something people fill in or tick off themselves."
- `skills/web-apps/SKILL.md` is rewritten for hosted apps: one file, the `kloru` data API, render
  from `kloru.list` and re-render in `onChange`, keep collection names across updates, choose
  `visitors` by who the app is for, phone-first layout. The Ample playbook moves to
  `skills/web-apps-ample/SKILL.md`, shown only when the Ample tools are.

Per `.claude/skills/prompt-editing`, the prompt change is measured with
`packages/server/test/apps.live.test.ts`: the engineer on the real model, with the real tools,
website and a phone-sized Chromium, for the grocery list (an app, tried with `app_test` before
the link is sent), the quantity follow-up (the same app updated) and "Summarize my week" (no app).
The PM bench doesn't run the engineer, so it can't measure this sentence.

## Files

| File | Change |
|---|---|
| `packages/desk/src/types.ts` | `kind`, `html`, `visitors` on `Artifact` and `ArtifactVersion` |
| `packages/desk/src/desk.ts` | `publishApp`, `updateApp`, `readApp`, `appTestUrl`; the prompt sentence; "(app)" in the brief |
| `packages/desk/src/apps.ts` | New: the three tools and the syntax check |
| `packages/server/src/boot.ts`, `app-errors.ts` | Register `appTools`; give `app_read` a function that reads an app's errors from `apps.db` (opened read-only) |
| `packages/server/src/browser-tools.ts`, `steel.ts` | `app_test` and its throwaway phone-sized browser |
| `packages/web/src/app-store.ts` | New: the SQLite store |
| `packages/web/src/app-pages.ts` | New: the shell page, the frame, `appAccess`, the `/pages` list |
| `packages/web/src/server.ts` | The routes above; `/pages` in the member allowlist and nav |
| `packages/web/static/app-shell.js`, `app-client.js` | New: the shell's bridge and the frame's `kloru` object |
| `packages/web/src/desk-pages.ts` | Kind column in the admin list |
| `skills/web-apps/SKILL.md`, `skills/web-apps-ample/SKILL.md` | Rewritten; moved |
| `SETUP.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` | Apps need no setup; `apps.db`; the frame's isolation |

`app_read` runs in the agent and errors live in the website's database. Both processes are on one
machine and the desk already shares its directory with the website, so the agent opens `apps.db`
read-only and passes the desk a plain function, `errorsOf(id, version)`; the desk never imports the
website. `boot.ts` gets the path from a new `KLORU_APPS_DB` (default `/data/kloru/apps.db`), and
`app_read` shows no errors when the file isn't there.

## Tests

- `packages/desk/test/apps.test.ts`: create, update by whole file and by `replace`, version
  history, the syntax check, size limits, a member's follow-up on another member's app, pages
  unaffected.
- `packages/web/test/app-store.test.ts`: records, `rev`, limits, errors kept per version.
- `packages/web/test/apps.test.ts`: the access table (each `visitors` value × family, visitor,
  nobody) on the shell, frame and data routes; the frame's headers exactly; write keys; a
  taken-down app returns 410; `/pages` shows a member their pages and the family's apps only.
- `packages/server/test/browser-tools.test.ts`: `app_test` on a real Chromium: phone width, a
  fresh load each run, nothing off-site loads, no `fillSecret`, a member's task may use it.
- `packages/server/test/apps.live.test.ts`: the three page-or-app cases, end to end.
- By hand, on two phones after deploy: the grocery list acceptance items.

## Not in this version

- Apps with their own server code, scheduled jobs or secrets (later: Ample, built in a sandbox).
- Outside libraries, fonts or images in an app.
- The engineer reading or writing an app's records ("what's on the grocery list?").
- An automated browser run of each app before the link goes out.
- Live push; polling every 2 s is enough for a family.
