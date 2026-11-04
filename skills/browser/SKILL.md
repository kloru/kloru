---
name: browser
description: Use the web as the person would, in Kloru's own browser, with their saved logins and cards used by reference. Use for signing up, logging in, reading an account, filling a form or checking out on a site without an API.
---

# Browser

Each person has their own browser profile, so a site they signed in to stays signed in. Kloru drives
it with Playwright.

## Playwright

`browser_run` runs Playwright code against this task's tab; the tab stays open between runs. Look,
then act, then look again:

```js
await page.goto("https://parking.flysfo.com/book/SFO/Parking");
return await page.locator("body").ariaSnapshot();
```

Use plain Playwright for everything: `getByRole`, `fill`, `selectOption`, `click`, `waitForURL`,
frames, scrolling, a date picker's own calendar. Return only what you need to see next. When a step
doesn't take, try another way before you say it can't be done, and then say which step stopped you.

## Secrets by name

Secrets live in the vault and you never see them. The ticket lists what this request may use, by
name, with safe details (brand and last 4, site and username).

- Log in: fill the username, then `await fillSecret("#password", "evan-pge-login.password")`.
- Pay: `browser_pay` with the card's name and the card fields' selectors. Cards never go in a script.
  It says if anything is needed; don't decide from old pages, earlier results or the audit log.
- No card saved: get everything ready up to payment, then text the person the Vault link to add one.
- An API: `script_run` with the key listed in `secrets`, read from `process.env`.

## Sign up for them

No saved login for a site: make the account yourself, as the person.

1. Fill in their details from memory (name, their own email, phone, address, car plate). Ask in one
   text for anything missing, and save the answer to memory.
2. `vault_save_login` before you submit, then `fillSecret` its password into both password fields.
3. A confirmation email or link: find it in their mail (store_search, or the mail app) and open it.
4. Tell them in one line: "Made you an SFO parking account as evan@…; the login is in your Vault."

Never ask anyone to text a password or a card number; those go in the Vault on kloru.com.

## Stop and ask

- A CAPTCHA you can see (a checkbox, an image grid), a code sent to their phone, a bank's card
  check: `browser_takeover` with what they need to do. They get a link to this tab, do it, and you
  carry on. A "protected by reCAPTCHA" badge asks nothing; carry on.
- A total that differs from what was agreed: stop and ask.
