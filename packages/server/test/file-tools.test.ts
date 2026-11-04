import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolResultLike } from "@kloru/core";
import { FILE_TOOL_CAPABILITIES, fileTools, resolveInsideWorkspace, shellEnvFor, workspacePathGuard } from "../src/file-tools.js";

const ctx: ToolContext = {
  principal: { kind: "owner", id: "owner", tier: "owner", displayName: "M" },
  conversationKey: "chat:default",
  channel: "chat",
  now: () => new Date(),
};

function textOf(result: ToolResultLike): string {
  return typeof result === "string" ? result : result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function isError(result: ToolResultLike): boolean {
  return typeof result !== "string" && result.isError === true;
}

describe("fileTools", () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "instinct-files-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "instinct-outside-")));
    writeFileSync(join(outside, "secret.json"), '{"signingKey":"whsec_do_not_leak"}');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const byName = (d: string, opts?: Parameters<typeof fileTools>[1]) => Object.fromEntries(fileTools(d, opts).map((t) => [t.spec.name, t.spec]));

  it("registers the Pi tools with file capabilities", () => {
    const tools = fileTools(dir);
    const names = tools.map((t) => t.spec.name).sort();
    expect(names).toEqual(["bash", "edit", "grep", "ls", "read", "write"]);
    for (const t of tools) {
      expect(t.spec.meta.group).toBe("files");
      expect(t.spec.meta.capabilities).toEqual(FILE_TOOL_CAPABILITIES[t.spec.name]);
    }
    expect(fileTools(dir, { bash: false }).map((t) => t.spec.name)).not.toContain("bash");
  });

  it("read-only tools need files.read and mutating tools need files.write", () => {
    expect(FILE_TOOL_CAPABILITIES.read).toEqual(["files.read"]);
    expect(FILE_TOOL_CAPABILITIES.write).toEqual(["files.write"]);
    expect(FILE_TOOL_CAPABILITIES.bash).toEqual(["files.read", "files.write"]);
  });

  it("writes and reads inside the workspace", async () => {
    const tools = byName(dir);
    const written = await tools.write!.execute({ path: "notes/hello.txt", content: "hello workspace" }, ctx);
    expect(isError(written)).toBe(false);
    expect(readFileSync(join(dir, "notes", "hello.txt"), "utf8")).toBe("hello workspace");
    expect(textOf(await tools.read!.execute({ path: "notes/hello.txt" }, ctx))).toContain("hello workspace");
    expect(textOf(await tools.read!.execute({ path: join(dir, "notes/hello.txt") }, ctx))).toContain("hello workspace");
  });

  it("reports missing files as errors instead of throwing silently", async () => {
    const read = fileTools(dir).find((t) => t.spec.name === "read")!.spec;
    await expect(read.execute({ path: "does-not-exist.txt" }, ctx)).rejects.toThrow();
  });

  describe("workspace path guard", () => {
    it("refuses absolute paths, parent traversal and ~ on every path tool", async () => {
      const tools = byName(dir);
      const escapes = [join(outside, "secret.json"), "../" + outside.split("/").pop() + "/secret.json", "/etc/hosts", "~/.ssh/id_rsa", "~"];
      for (const name of ["read", "ls", "grep", "write", "edit"]) {
        for (const p of escapes) {
          const args = name === "write" ? { path: p, content: "x" } : name === "edit" ? { path: p, oldText: "a", newText: "b" } : name === "grep" ? { pattern: "a", path: p } : { path: p };
          const result = await tools[name]!.execute(args, ctx);
          expect(isError(result), `${name} ${p}`).toBe(true);
          expect(textOf(result)).toContain("outside the workspace");
        }
      }
      expect(readFileSync(join(outside, "secret.json"), "utf8")).toContain("whsec_do_not_leak");
    });

    it("refuses a symlink inside the workspace that points outside", async () => {
      symlinkSync(join(outside, "secret.json"), join(dir, "link.json"));
      symlinkSync(outside, join(dir, "linkdir"));
      const tools = byName(dir);
      expect(isError(await tools.read!.execute({ path: "link.json" }, ctx))).toBe(true);
      expect(isError(await tools.read!.execute({ path: "linkdir/secret.json" }, ctx))).toBe(true);
      expect(isError(await tools.ls!.execute({ path: "linkdir" }, ctx))).toBe(true);
      // Writing through the link would land outside too.
      expect(isError(await tools.write!.execute({ path: "linkdir/new.txt", content: "x" }, ctx))).toBe(true);
      expect(isError(await tools.write!.execute({ path: "link.json", content: "x" }, ctx))).toBe(true);
      expect(readFileSync(join(outside, "secret.json"), "utf8")).toContain("whsec_do_not_leak");
    });

    it("allows the workspace root, nested paths that do not exist yet, and internal symlinks", async () => {
      mkdirSync(join(dir, "real"));
      writeFileSync(join(dir, "real", "a.txt"), "inside");
      symlinkSync(join(dir, "real"), join(dir, "alias"));
      const tools = byName(dir);
      expect(isError(await tools.ls!.execute({ path: "." }, ctx))).toBe(false);
      expect(isError(await tools.ls!.execute({}, ctx))).toBe(false);
      expect(isError(await tools.write!.execute({ path: "deep/er/new.txt", content: "ok" }, ctx))).toBe(false);
      expect(textOf(await tools.read!.execute({ path: "alias/a.txt" }, ctx))).toContain("inside");
    });

    it("resolveInsideWorkspace judges paths by their real location", () => {
      expect(resolveInsideWorkspace(dir, "a/b.txt")).toBe(join(dir, "a", "b.txt"));
      expect(resolveInsideWorkspace(dir, ".")).toBe(dir);
      expect(resolveInsideWorkspace(dir, "..")).toBeUndefined();
      expect(resolveInsideWorkspace(dir, `${dir}-sibling/x`)).toBeUndefined();
      expect(resolveInsideWorkspace(dir, "~/x")).toBeUndefined();
      const guard = workspacePathGuard(dir);
      expect(guard({ path: "ok.txt" })).toBeUndefined();
      expect(guard({ pattern: "x" })).toBeUndefined();
      expect(guard(undefined)).toBeUndefined();
      expect(guard({ path: "/etc/passwd" })?.isError).toBe(true);
    });
  });

  describe("bash environment", () => {
    it("does not inherit credentials from the process environment", async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-leak-me",
        INKBOX_API_KEY: "ibx_leak",
        INKBOX_SIGNING_KEY: "whsec_leak",
        COMPOSIO_API_KEY: "comp_leak",
        MARITIME_INTERNAL_TOKEN: "mt_leak",
        OPENAI_API_KEY: "sk-leak",
        DB_PASSWORD: "pw_leak",
        INSTINCT_DATA_DIR: "/data",
        HARMLESS_SETTING: "visible?",
        TZ: "America/New_York",
      };
      const tools = byName(dir, { env });
      const out = textOf(await tools.bash!.execute({ command: "env" }, ctx));
      for (const leak of ["sk-ant-leak-me", "ibx_leak", "whsec_leak", "comp_leak", "mt_leak", "sk-leak", "pw_leak", "HARMLESS_SETTING", "INSTINCT_DATA_DIR"]) {
        expect(out, leak).not.toContain(leak);
      }
      expect(out).toContain("TZ=America/New_York");
      expect(out).toMatch(/^PATH=/m);
    });

    it("falls back to process.env, still filtered", async () => {
      const before = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-from-process";
      try {
        const out = textOf(await byName(dir).bash!.execute({ command: "env; echo cwd=$PWD" }, ctx));
        expect(out).not.toContain("sk-ant-from-process");
        expect(out).toContain(`cwd=${dir}`);
      } finally {
        if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = before;
      }
    });

    it("shellEnvFor keeps only the allowlist and drops credential-looking names even there", () => {
      const env = shellEnvFor({
        PATH: "/usr/bin",
        HOME: "/home/x",
        LC_ALL: "C.UTF-8",
        LANG: "en_US.UTF-8",
        TERM: "xterm",
        TMPDIR: "/tmp",
        PATH_TOKEN: "nope",
        SOME_SECRET: "nope",
        MY_API_KEY: "nope",
        RANDOM_SETTING: "nope",
        EMPTY: undefined,
      });
      expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", LC_ALL: "C.UTF-8", LANG: "en_US.UTF-8", TERM: "xterm", TMPDIR: "/tmp" });
    });
  });
});
