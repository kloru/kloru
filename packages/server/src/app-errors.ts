/**
 * Script errors people's browsers reported from an app, read from the website's store. The agent
 * only reads: the file is the website's, and may not exist until someone first opens an app.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function appErrorsReader(path: string, log: (m: string) => void = () => undefined): (id: string, version: number) => string[] {
  let db: DatabaseSync | undefined;
  return (id, version) => {
    try {
      if (!db) {
        if (!existsSync(path)) return [];
        db = new DatabaseSync(path, { readOnly: true });
      }
      const rows = db.prepare("SELECT message FROM app_errors WHERE app = ? AND version = ? ORDER BY at, rowid").all(id, version) as { message: string }[];
      return rows.map((r) => r.message);
    } catch (error) {
      log(`apps: errors unreadable (${error instanceof Error ? error.message : String(error)})`);
      db = undefined;
      return [];
    }
  };
}
