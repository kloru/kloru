import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appErrorsReader } from "../src/app-errors.js";

describe("script errors an app reported, read from the website's store (#43)", () => {
  it("is empty until the website has made the file, then reads that version's errors in order, never writing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apps-db-")), "apps.db");
    const read = appErrorsReader(path);
    expect(read("app1", 1)).toEqual([]);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE app_errors (app TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (app, version, message));");
    const add = db.prepare("INSERT INTO app_errors VALUES (?, ?, ?, ?)");
    add.run("app1", 2, "2026-11-09T18:00:01Z", "second");
    add.run("app1", 2, "2026-11-09T18:00:00Z", "first");
    add.run("app1", 1, "2026-11-09T17:00:00Z", "old version");
    add.run("app2", 2, "2026-11-09T18:00:00Z", "another app");
    expect(read("app1", 2)).toEqual(["first", "second"]);
    add.run("app1", 2, "2026-11-09T18:00:02Z", "later");
    expect(read("app1", 2)).toEqual(["first", "second", "later"]);
    db.close();
  });

  it("an unreadable store is no errors, said once in the log, not a failed tool", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apps-db-")), "apps.db");
    new DatabaseSync(path).close();
    const logged: string[] = [];
    expect(appErrorsReader(path, (m) => logged.push(m))("app1", 1)).toEqual([]);
    expect(logged[0]).toMatch(/apps: errors unreadable/);
  });
});
