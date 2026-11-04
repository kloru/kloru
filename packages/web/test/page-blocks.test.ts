import { describe, expect, it } from "vitest";
import { fromMarkdownBlocks, toMarkdownBlocks } from "../editor/blocks.js";

const img = (url: string, name = "x") => ({ type: "image", props: { url, name, caption: "" } });

describe("page media blocks round-trip through Markdown", () => {
  it("an image of a video, audio, PDF or document becomes that block; a picture stays an image", () => {
    const out = fromMarkdownBlocks([img("/m/m_0123456789abcdef.mp4", "Tour"), img("/m/m_0123456789abcdef.m4a"), img("/m/m_0123456789abcdef.pdf", "Quote"), img("/m/m_0123456789abcdef.docx"), img("/m/m_0123456789abcdef.jpg")]);
    expect(out.map((b) => b.type)).toEqual(["video", "audio", "pdf", "file", "image"]);
    expect(out[0]).toEqual({ type: "video", props: { url: "/m/m_0123456789abcdef.mp4", name: "Tour" } });
  });

  it("saving writes every media block back as an image, so the Markdown is ![name](url)", () => {
    const back = toMarkdownBlocks([{ type: "pdf", props: { url: "/m/m_1.pdf", name: "Quote" } }, { type: "paragraph", props: {} }]);
    expect(back[0]).toEqual({ type: "image", props: { url: "/m/m_1.pdf", caption: "Quote", name: "Quote" } });
    expect(back[1]!.type).toBe("paragraph");
  });

  it("nested blocks are mapped too", () => {
    const out = fromMarkdownBlocks([{ type: "bulletListItem", children: [img("/m/m_2.mov")] }]);
    expect(out[0]!.children![0]!.type).toBe("video");
  });
});
