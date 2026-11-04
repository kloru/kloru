import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

describe("markdown for artifact pages", () => {
  it("renders headings, paragraphs, lists, emphasis, code and links", () => {
    const html = renderMarkdown("# Dentists\n\nThree **good** options, *all* close.\n\n- Rockridge Kids\n- Smile Kids\n\n1. Call\n2. Book\n\nSee [their site](https://example.com/a?b=1&c=2) or `ask`.");
    expect(html).toContain("<h1>Dentists</h1>");
    expect(html).toContain("<p>Three <strong>good</strong> options, <em>all</em> close.</p>");
    expect(html).toContain("<ul><li>Rockridge Kids</li><li>Smile Kids</li></ul>");
    expect(html).toContain("<ol><li>Call</li><li>Book</li></ol>");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">their site</a>');
    expect(html).toContain("<code>ask</code>");
  });

  it("renders a table, the shape comparisons take", () => {
    const html = renderMarkdown("| Name | Stars |\n|---|---:|\n| Rockridge Kids | 4.9 |\n| Smile | 4.6 |");
    expect(html).toBe("<table><thead><tr><th>Name</th><th>Stars</th></tr></thead><tbody><tr><td>Rockridge Kids</td><td>4.9</td></tr><tr><td>Smile</td><td>4.6</td></tr></tbody></table>");
  });

  it("never lets HTML, scripts or script links through, whatever the model wrote", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [x](data:text/html,hi) [y]( JAVASCRIPT:alert(1))\n\n**"><svg onload=alert(1)>**');
    expect(html).not.toMatch(/<script|<img|<svg/i); // every tag is escaped
    expect(html).not.toMatch(/href="\s*(javascript|data):/i); // and no unsafe link is made
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<p>click x"); // the text stays, the link goes, nothing stray
  });

  it("bare links become links; mail links work; nothing else is linked", () => {
    const html = renderMarkdown("Book at https://rockridgekids.com/book. Or [email](mailto:hi@rk.com).");
    expect(html).toContain('<a href="https://rockridgekids.com/book" rel="noopener noreferrer nofollow">https://rockridgekids.com/book</a>.');
    expect(html).toContain('<a href="mailto:hi@rk.com" rel="noopener noreferrer nofollow">email</a>');
  });
});

describe("media on a page", () => {
  it("a picture, video, audio or PDF from Kloru's media shows as one; anything else stays text", () => {
    expect(renderMarkdown("![Receipt](/m/m_0123456789abcdef.jpg)")).toContain('<img src="/m/m_0123456789abcdef.jpg" alt="Receipt"');
    expect(renderMarkdown("![Tour](/m/m_0123456789abcdef.mp4)")).toContain('<video controls src="/m/m_0123456789abcdef.mp4"');
    expect(renderMarkdown("![Memo](/m/m_0123456789abcdef.m4a)")).toContain('<audio controls src="/m/m_0123456789abcdef.m4a"');
    expect(renderMarkdown("![Quote](/m/m_0123456789abcdef.pdf)")).toContain('<a href="/m/m_0123456789abcdef.pdf"');
    expect(renderMarkdown("![x](javascript:alert(1))")).not.toContain("<img");
    expect(renderMarkdown('![x" onerror="alert(1)](/m/m_0123456789abcdef.jpg)')).not.toContain('onerror="');
  });
});
