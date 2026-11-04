import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import type { CliIo } from "../src/io.js";

export interface Run {
  code: number;
  out: string;
  err: string;
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "instinct-cli-"));
}

export function makeIo(extra: Partial<CliIo> = {}): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    ...extra,
  };
  return { io, out: () => out, err: () => err };
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = {}, extra: Partial<CliIo> = {}): Promise<Run> {
  const { io, out, err } = makeIo(extra);
  const code = await runCli(argv, env, io);
  return { code, out: out(), err: err() };
}

/** A fetch stub that records calls and answers from a route table. */
export function fakeFetch(routes: Record<string, (init: RequestInit & { url: string }) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler({ ...init, url });
    }
    return new Response(JSON.stringify({ detail: `no route for ${url}` }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function readJson<T>(dir: string, ...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(dir, ...parts), "utf8")) as T;
}
