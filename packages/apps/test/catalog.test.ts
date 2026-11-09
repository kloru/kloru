import { describe, expect, it } from "vitest";
import { searchCatalog } from "../src/catalog.js";
import type { CatalogApp } from "../src/composio.js";

// In the catalog's order: most used first.
const APPS: CatalogApp[] = [
  { slug: "gmail", name: "Gmail", description: "Google's email service", category: "email" },
  { slug: "github", name: "GitHub", description: "Code hosting with Git repositories, issues and pull requests", category: "developer tools" },
  { slug: "googlecalendar", name: "Google Calendar", description: "Schedule events", category: "scheduling & booking" },
  { slug: "gitlab", name: "GitLab", description: "DevOps platform built on Git", category: "developer tools" },
  { slug: "digital_ocean", name: "DigitalOcean", description: "Cloud servers", category: "developer tools" },
  { slug: "legit_books", name: "Legit Books", description: "Bookkeeping", category: "accounting" },
  { slug: "outlook", name: "Outlook", description: "Microsoft email and calendar", category: "email" },
];
const names = (q: string) => searchCatalog(APPS, q).apps.map((a) => a.name);

describe("finding an app to connect", () => {
  it("a name's start comes first; a match inside a name after, ties in the catalog's order", () => {
    expect(names("git")).toEqual(["GitHub", "GitLab", "DigitalOcean", "Legit Books"]);
  });

  it("an exact name beats a prefix", () => {
    expect(names("gmail")[0]).toBe("Gmail");
    expect(names("calendar")).toEqual(["Google Calendar", "Outlook"]);
  });

  it("finds an app by what it's for: category, then description", () => {
    expect(names("email")).toEqual(["Gmail", "Outlook"]);
    expect(names("pull requests")).toEqual(["GitHub"]);
  });

  it("every word has to match", () => {
    expect(names("google calendar")).toEqual(["Google Calendar"]);
    expect(names("google bookkeeping")).toEqual([]);
  });

  it("says how many matched, and keeps to the limit", () => {
    expect(searchCatalog(APPS, "developer", 2)).toMatchObject({ total: 3, apps: [{ name: "GitHub" }, { name: "GitLab" }] });
    expect(searchCatalog(APPS, "  ")).toEqual({ apps: [], total: 0 });
  });
});
