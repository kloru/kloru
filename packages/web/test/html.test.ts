import { describe, expect, it } from "vitest";
import { esc, layout } from "../src/html.js";

describe("html", () => {
  it("escapes the five special characters", () => {
    expect(esc(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(esc(undefined)).toBe("");
    expect(esc(42)).toBe("42");
  });
  it("layout escapes the title, banner and email, and marks the active tab", () => {
    const page = layout({ title: "<T>", body: "<p>ok</p>", banner: { kind: "error", text: "<b>" }, user: { label: "<e>@x", admin: true }, active: "/permissions" });
    expect(page).toContain("&lt;T&gt;");
    expect(page).toContain("&lt;b&gt;");
    expect(page).toContain("&lt;e&gt;@x");
    expect(page).toContain('<a href="/permissions" aria-current="page">');
    expect(page).toContain('href="/admin"');
    expect(page).toContain("<p>ok</p>");
  });
  it("every page has the footer with the legal links", () => {
    const page = layout({ title: "T", body: "" });
    expect(page).toContain('<footer>');
    expect(page).toContain('href="/privacy"');
    expect(page).toContain('href="/terms"');
    expect(page).toContain('href="/why"');
  });
  it("hides nav when signed out and admin link for non-admins", () => {
    expect(layout({ title: "T", body: "" })).not.toContain("<nav>");
    expect(layout({ title: "T", body: "", user: { label: "a@b", admin: false } })).not.toContain('href="/admin"');
  });
});
