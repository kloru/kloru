/**
 * Markdown for artifact pages: headings, paragraphs, lists, tables, emphasis, code and links.
 * A page is written by a model that read emails and web pages, so everything is escaped first and
 * only this small set of formatting is added back; links must be http(s) or mailto.
 */
import { esc } from "./html.js";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function link(href: string, text: string): string {
  const raw = href.trim().replace(/&amp;/g, "&");
  return SAFE_URL.test(raw) ? `<a href="${esc(raw)}" rel="noopener noreferrer nofollow">${text}</a>` : text;
}

const MEDIA_SRC = /^(\/m\/m_[0-9a-f]{16}\.[a-z0-9]{1,5}|https:\/\/[^\s"'<>]+)$/;

/** ![alt](src): Kloru's own media or an https image, as a picture, a player or a link. `alt` is already escaped. */
function media(src: string, alt: string): string | undefined {
  if (!MEDIA_SRC.test(src)) return undefined;
  const url = esc(src);
  if (/\.(mp4|mov|webm)$/i.test(src)) return `<video controls src="${url}"></video>`;
  if (/\.(mp3|m4a|aac|wav|ogg|amr)$/i.test(src)) return `<audio controls src="${url}"></audio>`;
  if (/^\/m\//.test(src) && !/\.(jpe?g|png|gif|webp)$/i.test(src)) return `<a href="${url}">${alt || "Download"}</a>`;
  return `<img src="${url}" alt="${alt}" loading="lazy">`;
}

/** Inline formatting on text that is already escaped. */
function inline(escaped: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = escaped.replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (all: string, alt: string, src: string) => {
    const html = media(src.replace(/&amp;/g, "&"), alt);
    return html ? hold(html) : all;
  });
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (_, text: string, href: string) => hold(link(href, text)));
  s = s.replace(/https?:\/\/[^\s<\u0000]+/g, (url: string) => {
    const trail = /[.,;:!?)]+$/.exec(url)?.[0] ?? "";
    const bare = url.slice(0, url.length - trail.length);
    return hold(link(bare, bare)) + trail;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]!);
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(esc(c.trim())));

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const n = heading[1]!.length;
      out.push(`<h${n}>${inline(esc(heading[2]!.trim()))}</h${n}>`);
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) body.push(cells(lines[i++]!));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i]!)) items.push(`<li>${inline(esc(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, "")))}</li>`);
      i--;
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n").replace(/\n(?=<)/g, "");
}
