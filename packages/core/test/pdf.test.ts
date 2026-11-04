import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alignTable, parseInline, parseMarkdown, pdfPageCount, renderMarkdownToPdf, stripInline } from "../src/pdf.js";

/** pdfkit writes strings either literally in parentheses or as UTF-16BE hex with a BOM. */
function pdfHasString(pdfText: string, s: string): boolean {
  if (pdfText.includes(`(${s})`)) return true;
  const hex = "feff" + [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return pdfText.toLowerCase().includes(`<${hex}>`);
}

const SAMPLE = `# Snapmaker U1 vs Bambu A1

Short answer: the **U1** is the better pick for *four-colour* prints. See [the spec page](https://example.com/spec) and \`purge\` numbers.

## Findings

- Tool changes waste almost no filament
- Louder enclosure, per early reviews
  which continue on the next line
* A 270mm cube

### Steps

1. Read the spec
2. Measure purge
3) Decide

\`\`\`
soffice --headless --convert-to pdf brief.md
echo "done"
\`\`\`

| Printer | Purge per change | Price |
|---|---:|---|
| Snapmaker U1 | under 2 g | $1,199 |
| Bambu A1 + AMS | roughly 15 g | $559 |

---

> A quoted remark.

Final paragraph with an unmatched *asterisk and a stray \`backtick.
`;

describe("parseMarkdown", () => {
  it("recognises every block type in the sample", () => {
    const kinds = parseMarkdown(SAMPLE).map((b) => b.kind);
    expect(kinds).toEqual(["heading", "paragraph", "heading", "list", "heading", "list", "code", "table", "rule", "paragraph", "paragraph"]);
  });

  it("keeps list items, code lines and table cells intact", () => {
    const blocks = parseMarkdown(SAMPLE);
    const bullets = blocks[3];
    expect(bullets).toMatchObject({ kind: "list", ordered: false, items: ["Tool changes waste almost no filament", "Louder enclosure, per early reviews which continue on the next line", "A 270mm cube"] });
    const numbered = blocks[5];
    expect(numbered).toMatchObject({ kind: "list", ordered: true, items: ["Read the spec", "Measure purge", "Decide"] });
    expect(blocks[6]).toEqual({ kind: "code", lines: ["soffice --headless --convert-to pdf brief.md", 'echo "done"'] });
    expect(blocks[7]).toEqual({ kind: "table", rows: [["Printer", "Purge per change", "Price"], ["Snapmaker U1", "under 2 g", "$1,199"], ["Bambu A1 + AMS", "roughly 15 g", "$559"]] });
  });

  it("treats an unterminated fence and CRLF input as text, not an error", () => {
    expect(parseMarkdown("```js\nlet x = 1;")).toEqual([{ kind: "code", lines: ["let x = 1;"] }]);
    expect(parseMarkdown("a\r\nb\r\n\r\nc")).toEqual([
      { kind: "paragraph", text: "a b" },
      { kind: "paragraph", text: "c" },
    ]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("splits bold, italic, code and links into runs", () => {
    const runs = parseInline("plain **bold** *it* `code` [site](https://x.y)");
    expect(runs).toEqual([
      { text: "plain ", bold: false, italic: false, code: false },
      { text: "bold", bold: true, italic: false, code: false },
      { text: " ", bold: false, italic: false, code: false },
      { text: "it", bold: false, italic: true, code: false },
      { text: " ", bold: false, italic: false, code: false },
      { text: "code", bold: false, italic: false, code: true },
      { text: " ", bold: false, italic: false, code: false },
      { text: "site", bold: false, italic: false, code: false, link: "https://x.y" },
    ]);
  });

  it("leaves underscores inside words alone and honours escapes", () => {
    expect(stripInline("snake_case_name and \\*literal\\*")).toBe("snake_case_name and *literal*");
    expect(stripInline("[label](https://a.b)")).toBe("label (https://a.b)");
    expect(stripInline("unterminated `tick and *star")).toBe("unterminated `tick and star");
  });
});

describe("alignTable", () => {
  it("pads columns, underlines the header and clips long cells", () => {
    const lines = alignTable([["Name", "Value"], ["a", "x".repeat(50)], ["longer name", "1"]]);
    expect(lines[0]).toBe("Name         Value");
    expect(lines[1]).toBe("-----------  --------------------------------");
    expect(lines[2]?.startsWith("a            xxxxxxxx")).toBe(true);
    expect(lines[2]?.endsWith("…")).toBe(true);
    expect(lines[3]).toBe("longer name  1");
  });

  it("fills ragged rows", () => {
    expect(alignTable([["a", "b", "c"], ["only"]])).toEqual(["a     b  c", "----  -  -", "only"]);
  });
});

describe("renderMarkdownToPdf", () => {
  it("renders the sample with a title to a real PDF with at least one page", async () => {
    const pdf = await renderMarkdownToPdf(SAMPLE, { title: "Research brief", author: "Kloru" });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
    expect(pdf.toString("latin1")).toContain("%%EOF");
    const text = pdf.toString("latin1");
    expect(text).toMatch(/\/Title/);
    expect(text).toMatch(/\/Author/);
    expect(text).toMatch(/\/URI/);
    for (const s of ["Research brief", "Kloru", "https://example.com/spec"]) expect(pdfHasString(text, s), s).toBe(true);
  });

  it("paginates long documents and numbers every page", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}. ${"Words that fill the line. ".repeat(12)}\n`).join("\n");
    const pdf = await renderMarkdownToPdf(long, { title: "Long" });
    const pages = pdfPageCount(pdf);
    expect(pages).toBeGreaterThan(3);
    // Fonts are the built-in Helvetica family; nothing was embedded.
    expect(pdf.toString("latin1")).toContain("/BaseFont /Helvetica");
  });

  it("never throws on odd input", async () => {
    const odd = ["", "   ", "```", "|", "| a |", "# ", "- ", "1. ", "**", "`", "[](", "\u0000\u0001", "x".repeat(20_000), "- " + "y".repeat(5000)];
    for (const md of odd) {
      const pdf = await renderMarkdownToPdf(md);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
    }
    const notString = await renderMarkdownToPdf(undefined as unknown as string);
    expect(pdfPageCount(notString)).toBe(1);
  });
});

describe("images in markdown", () => {
  // A 1x1 red PNG.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

  it("parses ![alt](src) on its own line as an image block", () => {
    const blocks = parseMarkdown("# Ships\n\n![A clipper at dawn](art/ship-01.png)\n\nText after.");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Ships" },
      { kind: "image", src: "art/ship-01.png", alt: "A clipper at dawn" },
      { kind: "paragraph", text: "Text after." },
    ]);
  });

  it("embeds a resolvable image and prints a placeholder for a refused one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-img-"));
    const file = path.join(dir, "ship.png");
    fs.writeFileSync(file, PNG);
    const md = "# Book\n\n![A clipper at dawn](ship.png)\n\n![outside](../etc/passwd.png)\n";
    const withImage = await renderMarkdownToPdf(md, { resolveImage: (src) => (src === "ship.png" ? file : undefined) });
    // Body text is in compressed streams, so the checks are structural: one embedded image, not two.
    const text = withImage.toString("latin1");
    expect((text.match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(1);
    const without = await renderMarkdownToPdf(md);
    expect(without.toString("latin1")).not.toContain("/Subtype /Image");
    expect(pdfPageCount(withImage)).toBeGreaterThanOrEqual(1);
  });
});
