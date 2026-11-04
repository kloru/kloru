/**
 * Pages are Markdown, so agents and people edit the same document. Markdown has one media form,
 * ![name](url); on the page a media file's extension picks its block: a video or audio player, an
 * inline PDF, a download, or an image. Saving turns them back into ![name](url).
 */
export interface LooseBlock {
  type: string;
  props?: Record<string, unknown>;
  children?: LooseBlock[];
  [k: string]: unknown;
}

const VIDEO = /\.(mp4|mov|webm)(\?|#|$)/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|amr)(\?|#|$)/i;
const PDF = /\.pdf(\?|#|$)/i;
const FILE = /\.(docx?|xlsx?|pptx?|csv|txt|ics|vcf|md|heic|heif)(\?|#|$)/i;
const MEDIA_BLOCKS = new Set(["video", "audio", "pdf", "file"]);

/** After parsing Markdown: an image whose file is a video, audio, PDF or document becomes that block. */
export function fromMarkdownBlocks(blocks: LooseBlock[]): LooseBlock[] {
  return blocks.map((b) => {
    const children = b.children ? fromMarkdownBlocks(b.children) : b.children;
    if (b.type !== "image") return { ...b, ...(children ? { children } : {}) };
    const url = String(b.props?.url ?? "");
    const name = String(b.props?.name || b.props?.caption || "");
    const type = VIDEO.test(url) ? "video" : AUDIO.test(url) ? "audio" : PDF.test(url) ? "pdf" : FILE.test(url) ? "file" : "image";
    if (type === "image") return { ...b, ...(children ? { children } : {}) };
    return { type, props: { url, name }, ...(children ? { children } : {}) };
  });
}

/** Before saving as Markdown: every media block is written as ![name](url). */
export function toMarkdownBlocks(blocks: LooseBlock[]): LooseBlock[] {
  return blocks.map((b) => {
    const children = b.children ? toMarkdownBlocks(b.children) : b.children;
    if (!MEDIA_BLOCKS.has(b.type)) return { ...b, ...(children ? { children } : {}) };
    const url = String(b.props?.url ?? "");
    const name = String(b.props?.name || b.props?.caption || "");
    return { type: "image", props: { url, caption: name, name }, ...(children ? { children } : {}) };
  });
}
