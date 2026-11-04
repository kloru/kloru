/**
 * A Kloru page in the browser: BlockNote renders the page's Markdown as blocks (media as players,
 * PDFs inline). Family members who are signed in can edit; each pause saves the page back as
 * Markdown, so agents and people edit the same document and every version is kept.
 */
import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactBlockSpec, useCreateBlockNote } from "@blocknote/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fromMarkdownBlocks, toMarkdownBlocks, type LooseBlock } from "./blocks.js";

interface PageData {
  id: string;
  title: string;
  markdown: string;
  editable: boolean;
  csrf?: string;
}

const pdf = createReactBlockSpec(
  { type: "pdf", propSchema: { url: { default: "" }, name: { default: "" } }, content: "none" },
  { render: ({ block }) => <iframe className="kloru-pdf" src={block.props.url} title={block.props.name || "PDF"} /> },
);
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, pdf: pdf() } });

function Page({ data }: { data: PageData }) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // The page as loaded, in the editor's own Markdown: only a change from it is an edit worth saving.
  const baseline = useRef<string | undefined>(undefined);
  const markdownOf = () => editor.blocksToMarkdownLossy(toMarkdownBlocks(editor.document as unknown as LooseBlock[]) as never);
  const editor = useCreateBlockNote({
    schema,
    ...(data.editable
      ? {
          uploadFile: async (file: File) => {
            const res = await fetch(`/a/${data.id}/upload`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-csrf": data.csrf ?? "", "x-filename": encodeURIComponent(file.name) }, body: file });
            if (!res.ok) throw new Error(await res.text());
            return ((await res.json()) as { url: string }).url;
          },
        }
      : {}),
  });

  useEffect(() => {
    const blocks = fromMarkdownBlocks(editor.tryParseMarkdownToBlocks(data.markdown) as unknown as LooseBlock[]);
    editor.replaceBlocks(editor.document, blocks as unknown as PartialBlock<typeof schema.blockSchema>[]);
    // Replacing leaves the selection on the last block, which would pop up its toolbar.
    const first = editor.document[0];
    if (first) editor.setTextCursorPosition(first, "start");
    baseline.current = markdownOf();
  }, [editor, data.markdown]);

  const save = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // Loading the page fires a change too; opening a page never saves it.
      if (baseline.current === undefined) return;
      const markdown = markdownOf();
      if (markdown === baseline.current) return;
      setStatus("Saving…");
      const res = await fetch(`/a/${data.id}/edit`, { method: "POST", headers: { "content-type": "application/json", "x-csrf": data.csrf ?? "" }, body: JSON.stringify({ markdown }) }).catch(() => undefined);
      if (res?.ok) baseline.current = markdown;
      setStatus(res?.ok ? "Saved" : "Couldn't save; your changes are still here");
    }, 1500);
  };

  return (
    <>
      <BlockNoteView
        editor={editor}
        editable={data.editable}
        theme={matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}
        // Reading: just the page. Editing: BlockNote's menus and toolbars.
        formattingToolbar={data.editable}
        linkToolbar={data.editable}
        sideMenu={data.editable}
        slashMenu={data.editable}
        filePanel={data.editable}
        tableHandles={data.editable}
        {...(data.editable ? { onChange: save } : {})}
      />
      {data.editable ? <p className="kloru-status">{status}</p> : null}
    </>
  );
}

const el = document.getElementById("kloru-page-data");
const root = document.getElementById("kloru-editor");
if (el && root) {
  const data = JSON.parse(el.textContent ?? "{}") as PageData;
  document.getElementById("kloru-fallback")?.remove();
  createRoot(root).render(
    <StrictMode>
      <Page data={data} />
    </StrictMode>,
  );
}
