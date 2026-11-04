/**
 * Markdown to PDF with pdfkit and the built-in Helvetica and Courier fonts.
 * Covers what the agent writes: headings, paragraphs, lists, bold and italic,
 * links, code blocks and simple pipe tables. Odd markdown never throws; the
 * worst case is plain text in a PDF.
 */
import PDFDocument from "pdfkit";

export interface PdfOptions {
  title?: string;
  author?: string;
  /** Turn an image reference (`![alt](src)`) into a readable absolute path, or undefined to refuse it. */
  resolveImage?: (src: string) => string | undefined;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "rule" };

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link?: string;
}

const PAGE_MARGIN = 56;
const BODY_SIZE = 11;
const CODE_SIZE = 9;
const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 13, 4: 12, 5: 11, 6: 11 };
const TABLE_CELL_CAP = 32;

/** Render markdown to a PDF. Resolves to the file bytes; page numbers go in the footer. */
export async function renderMarkdownToPdf(markdown: string, opts: PdfOptions = {}): Promise<Buffer> {
  const source = typeof markdown === "string" ? markdown : String(markdown ?? "");
  let blocks: Block[];
  try {
    blocks = parseMarkdown(source);
  } catch {
    blocks = [{ kind: "paragraph", text: source }];
  }
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN }, bufferPages: true, info: pdfInfo(opts) });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      renderTitle(doc, opts);
      for (const block of blocks) {
        try {
          renderBlock(doc, block, opts);
        } catch {
          // A block that pdfkit rejects (bad glyphs, odd widths) becomes plain text.
          safeText(doc, blockText(block));
        }
      }
      renderFooters(doc);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    doc.end();
  });
}

/** Number of pages in a PDF produced by pdfkit (counts /Type /Page objects). */
export function pdfPageCount(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return matches ? matches.length : 0;
}

function pdfInfo(opts: PdfOptions): PDFKit.DocumentInfo {
  const info: PDFKit.DocumentInfo = { Creator: "Kloru" };
  if (opts.title) info.Title = opts.title;
  if (opts.author) info.Author = opts.author;
  return info;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split markdown into blocks. Tolerant: anything unrecognised is a paragraph. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ").replace(/\s+/g, " ").trim() });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      flushParagraph();
      const fence = trimmed.startsWith("```") ? "```" : "~~~";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence)) {
        code.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ kind: "code", lines: code });
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      continue;
    }

    const image = /^!\[([^\]]*)\]\((\S+?)\)$/.exec(trimmed);
    if (image) {
      flushParagraph();
      blocks.push({ kind: "image", src: image[2] ?? "", alt: image[1] ?? "" });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph();
      const rows: string[][] = [];
      while (i < lines.length) {
        const row = (lines[i] ?? "").trim();
        if (!(row.startsWith("|") && row.endsWith("|"))) break;
        const cells = splitTableRow(row);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(cells);
        i++;
      }
      i--;
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const row = (lines[i] ?? "").trim();
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(row) : /^[-*+]\s+(.*)$/.exec(row);
        if (m) {
          items.push(m[1] ?? "");
        } else if (row !== "" && items.length > 0 && /^\s+/.test(lines[i] ?? "")) {
          // Indented continuation line belongs to the previous item.
          items[items.length - 1] = `${items[items.length - 1]} ${row}`;
        } else {
          break;
        }
        i++;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    paragraph.push(quote ? (quote[1] ?? "") : trimmed);
  }
  flushParagraph();
  return blocks;
}

function splitTableRow(row: string): string[] {
  const inner = row.slice(1, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Inline markdown to styled runs: **bold**, *italic*, `code`, [text](url). */
export function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let buf = "";
  const push = (extra: Partial<Run> = {}) => {
    if (!buf) return;
    runs.push({ text: buf, bold, italic, code: false, ...extra });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1];
    if (ch === "\\" && next && /[\\`*_[\]()#|]/.test(next)) {
      buf += next;
      i++;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        push();
        runs.push({ text: text.slice(i + 1, end), bold, italic, code: true });
        i = end;
        continue;
      }
    }
    if (ch === "[") {
      const close = text.indexOf("](", i);
      const end = close > 0 ? text.indexOf(")", close + 2) : -1;
      if (close > i && end > close) {
        push();
        const label = text.slice(i + 1, close);
        const url = text.slice(close + 2, end).trim();
        runs.push({ text: label || url, bold, italic, code: false, link: url });
        i = end;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && next === ch) {
      push();
      bold = !bold;
      i++;
      continue;
    }
    if (ch === "*" || (ch === "_" && isWordBoundary(text, i))) {
      push();
      italic = !italic;
      continue;
    }
    buf += ch;
  }
  push();
  return runs;
}

function isWordBoundary(text: string, i: number): boolean {
  const before = text[i - 1];
  const after = text[i + 1];
  return !before || !after || /\s/.test(before) || /\s/.test(after);
}

/** Markdown with the inline markers removed, for table cells and fallbacks. */
export function stripInline(text: string): string {
  return parseInline(text)
    .map((r) => (r.link && r.text !== r.link ? `${r.text} (${r.link})` : r.text))
    .join("");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTitle(doc: PDFKit.PDFDocument, opts: PdfOptions): void {
  if (!opts.title && !opts.author) return;
  if (opts.title) doc.font("Helvetica-Bold").fontSize(24).fillColor("#111111").text(opts.title, { align: "left" });
  if (opts.author) doc.font("Helvetica").fontSize(10).fillColor("#666666").text(opts.author);
  doc.moveDown(0.4);
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor("#bbbbbb").stroke();
  doc.moveDown(0.8);
  doc.fillColor("#111111");
}

const IMAGE_MAX_HEIGHT = 440;

function renderBlock(doc: PDFKit.PDFDocument, block: Block, opts: PdfOptions = {}): void {
  switch (block.kind) {
    case "image": {
      const file = opts.resolveImage?.(block.src);
      if (!file) {
        doc.font("Helvetica-Oblique").fontSize(BODY_SIZE).fillColor("#666666");
        safeText(doc, block.alt ? `[image: ${block.alt}]` : "[image]");
        doc.moveDown(0.4);
        return;
      }
      const width = contentWidth(doc);
      if (doc.y > doc.page.height - doc.page.margins.bottom - Math.min(IMAGE_MAX_HEIGHT, width)) doc.addPage();
      try {
        doc.image(file, doc.page.margins.left, doc.y, { fit: [width, IMAGE_MAX_HEIGHT], align: "center" });
        doc.y = Math.min(doc.y + IMAGE_MAX_HEIGHT, doc.page.height - doc.page.margins.bottom);
        doc.moveDown(0.3);
      } catch {
        doc.font("Helvetica-Oblique").fontSize(BODY_SIZE).fillColor("#666666");
        safeText(doc, block.alt ? `[image could not be embedded: ${block.alt}]` : "[image could not be embedded]");
      }
      if (block.alt) {
        doc.font("Helvetica-Oblique").fontSize(CODE_SIZE).fillColor("#555555");
        safeText(doc, block.alt);
      }
      doc.moveDown(0.6);
      return;
    }
    case "heading": {
      const size = HEADING_SIZES[block.level] ?? BODY_SIZE;
      doc.moveDown(block.level <= 2 ? 0.6 : 0.4);
      doc.font("Helvetica-Bold").fontSize(size).fillColor("#111111");
      renderRuns(doc, parseInline(block.text), { size, baseBold: true });
      doc.moveDown(0.3);
      return;
    }
    case "paragraph":
      doc.font("Helvetica").fontSize(BODY_SIZE).fillColor("#111111");
      renderRuns(doc, parseInline(block.text), { size: BODY_SIZE, paragraphGap: 6 });
      return;
    case "list": {
      doc.font("Helvetica").fontSize(BODY_SIZE).fillColor("#111111");
      const indent = 18;
      block.items.forEach((item, idx) => {
        const marker = block.ordered ? `${idx + 1}.` : "•";
        const x = doc.page.margins.left;
        const y = doc.y;
        doc.font("Helvetica").text(marker, x, y, { width: indent, lineBreak: false });
        doc.x = x + indent;
        doc.y = y;
        renderRuns(doc, parseInline(item), { size: BODY_SIZE, width: contentWidth(doc) - indent, paragraphGap: 2 });
        doc.x = x;
      });
      doc.moveDown(0.4);
      return;
    }
    case "code": {
      doc.moveDown(0.3);
      doc.font("Courier").fontSize(CODE_SIZE).fillColor("#222222");
      const text = block.lines.join("\n") || " ";
      doc.text(text, doc.page.margins.left + 10, doc.y, { width: contentWidth(doc) - 20, lineGap: 1 });
      doc.x = doc.page.margins.left;
      doc.moveDown(0.8);
      doc.fillColor("#111111");
      return;
    }
    case "table": {
      doc.moveDown(0.3);
      doc.font("Courier").fontSize(CODE_SIZE).fillColor("#111111");
      for (const line of alignTable(block.rows)) doc.text(line, { width: contentWidth(doc), lineGap: 1 });
      doc.moveDown(0.8);
      return;
    }
    case "rule": {
      doc.moveDown(0.3);
      const y = doc.y;
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor("#bbbbbb").stroke();
      doc.moveDown(0.6);
      return;
    }
  }
}

interface RunOptions {
  size: number;
  baseBold?: boolean;
  width?: number;
  paragraphGap?: number;
}

/** Write styled runs as one flowing paragraph, switching fonts between them. */
function renderRuns(doc: PDFKit.PDFDocument, runs: Run[], opts: RunOptions = { size: BODY_SIZE }): void {
  const width = opts.width ?? contentWidth(doc);
  if (runs.length === 0) {
    doc.text(" ", { width });
    return;
  }
  runs.forEach((run, i) => {
    const last = i === runs.length - 1;
    doc.font(fontFor(run, opts.baseBold ?? false));
    doc.fontSize(run.code ? Math.max(8, opts.size - 1) : opts.size);
    // `continued` carries link and underline into the next run unless they are reset.
    const textOpts: PDFKit.Mixins.TextOptions = { width, continued: !last, paragraphGap: opts.paragraphGap ?? 0, link: run.link ?? null, underline: Boolean(run.link) };
    doc.text(run.text, textOpts);
  });
}

function fontFor(run: Run, baseBold: boolean): string {
  if (run.code) return "Courier";
  const bold = run.bold || baseBold;
  if (bold && run.italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (run.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/** Pipe table rows as padded monospace lines with a dashed line under the header. */
export function alignTable(rows: string[][]): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: cols }, (_, c) => clipCell(stripInline(r[c] ?? ""))));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...cells.map((r) => r[c]!.length)));
  const line = (r: string[]) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd();
  const out: string[] = [];
  cells.forEach((r, i) => {
    out.push(line(r));
    if (i === 0 && cells.length > 1) out.push(widths.map((w) => "-".repeat(w)).join("  "));
  });
  return out;
}

function clipCell(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TABLE_CELL_CAP ? flat : `${flat.slice(0, TABLE_CELL_CAP - 1)}…`;
}

function renderFooters(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    // Writing inside the bottom margin would otherwise trigger a new page.
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(9).fillColor("#888888");
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 32, { width: contentWidth(doc), align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function safeText(doc: PDFKit.PDFDocument, text: string): void {
  try {
    doc.font("Helvetica").fontSize(BODY_SIZE).fillColor("#111111").text(text || " ", doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  } catch {
    // Nothing left to try; skip the block rather than fail the document.
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "image":
      return block.alt;
    case "heading":
    case "paragraph":
      return stripInline(block.text);
    case "list":
      return block.items.map((it, i) => `${block.ordered ? `${i + 1}.` : "-"} ${stripInline(it)}`).join("\n");
    case "code":
      return block.lines.join("\n");
    case "table":
      return alignTable(block.rows).join("\n");
    case "rule":
      return "";
  }
}
