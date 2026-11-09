/**
 * Finding an app to connect among Composio's ~1,700: by name first, then by what it's for.
 * Every word has to match somewhere; ties keep the catalog's order (most used first).
 */
import type { CatalogApp } from "./composio.js";

export function searchCatalog(apps: CatalogApp[], query: string, limit = 30): { apps: CatalogApp[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { apps: [], total: 0 };
  const scored: Array<{ app: CatalogApp; score: number; i: number }> = [];
  apps.forEach((app, i) => {
    const name = app.name.toLowerCase();
    const slug = app.slug.replace(/_/g, " ");
    const nameWords = `${name} ${slug}`.split(/[\s._-]+/);
    const category = (app.category ?? "").toLowerCase();
    const description = app.description.toLowerCase();
    let score = 0;
    for (const w of words) {
      const s =
        name === w || app.slug === w ? 100
        : name.startsWith(w) || slug.startsWith(w) ? 80
        : nameWords.some((x) => x.startsWith(w)) ? 60
        : name.includes(w) || slug.includes(w) ? 50
        : category.includes(w) ? 30
        : description.includes(w) ? 10
        : 0;
      if (!s) return;
      score += s;
    }
    scored.push({ app, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { apps: scored.slice(0, limit).map((x) => x.app), total: scored.length };
}
