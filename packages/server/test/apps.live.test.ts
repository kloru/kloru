/**
 * The engineer on the real model, making an app end to end (#43): the real tools, the real
 * website over the same desk, and a real phone-sized Chromium for app_test. Needs
 * OPENROUTER_API_KEY and a browser:
 *   set -a && . ./.instinct.env && set +a && cd packages/server && npx vitest run test/apps.live.test.ts
 * ENGINEER_MODEL tries another model; unset, INSTINCT_MODEL. APPS_OUT keeps the app and a screenshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { EZRA, chrome, key, setup } from "./apps-live.js";

const spec = process.env.ENGINEER_MODEL ?? process.env.INSTINCT_MODEL ?? "";

describe.skipIf(!key || !chrome || !spec)("an engineer makes an app, live", () => {
  it("a shared grocery list is an app, tried on a phone before the link is sent; a follow-up changes the same app; a summary is still a page", async () => {
    const { desk, request, close } = await setup({ engineer: spec });
    try {
      const made = await request("Make us a shared grocery list", "app");
      console.log(made.text, made.calls);
      const apps = () => desk.repo.artifacts().filter((a) => a.kind === "app");
      expect(apps()).toHaveLength(1);
      const app = apps()[0]!;
      expect(made.calls).toContain("engineer:app_test");
      expect(made.text).toContain(desk.artifactUrl(app.id));
      expect(made.text.length).toBeLessThan(400);
      expect(app.html).toMatch(/kloru\.(list|put)/);

      const changed = await request("Add a quantity field to the grocery list", "app", made.issue.id);
      console.log(changed.text, changed.calls);
      expect(apps()).toHaveLength(1);
      expect(apps()[0]!.id).toBe(app.id);
      expect(apps()[0]!.version ?? 1).toBeGreaterThan(app.version ?? 1);
      expect(apps()[0]!.html).toMatch(/quantity|qty/i);
      expect(changed.text).toContain(desk.artifactUrl(app.id));

      const week = await request("Summarize my week", "page");
      console.log(week.text, week.calls);
      expect(week.calls).not.toContain("engineer:app_create");
      expect(apps()).toHaveLength(1);

      // What the family would see, on a phone, with something on the list.
      const out = process.env.APPS_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "grocery-list.html"), apps()[0]!.html ?? "");
        const link = desk.appTestUrl(app.id, EZRA);
        if (!link.ok) throw new Error(link.error);
        const browser = await chromium.launch({ executablePath: chrome!, headless: true });
        const page = await browser.newPage({ viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.goto(link.value);
        await page.frameLocator("#kloru-app").locator("body").waitFor();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(out, "grocery-list.png") });
        await browser.close();
      }
    } finally {
      await close();
    }
  }, 600_000);
});
