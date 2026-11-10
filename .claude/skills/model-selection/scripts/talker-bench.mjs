/**
 * The texting model (step 2) on Kloru's own cases, per candidate model: pass rate and median time.
 * Build first (pnpm --filter @kloru/server run build), then from the repo root:
 *   set -a && . ./.instinct.env && set +a && node .claude/skills/model-selection/scripts/talker-bench.mjs <model> [<model> …]
 * Each case is a real miss or a rule it must keep; add one whenever a real conversation goes wrong.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { textTalker } = await import(pathToFileURL(resolve("packages/server/dist/text-talker.js")).href);
const key = process.env.OPENROUTER_API_KEY;
const MODELS = process.argv.slice(2);
const RUNS = Number(process.env.RUNS ?? 5);
const BRIEF = "Caller: Ezra. Lives in Portland. People: Nora: Ezra's daughter, 3 | Cleo: Ezra's wife";
const REAL = `How they want Kloru to work (their guidelines, which win):
- Be eager: do the whole thing. Check with me first only before something reaches another person, spends money, or can't be undone.
- For email response alerts, do not text before 7 AM or at or after 7 PM Pacific; continue checking email every 15 minutes.
- Keep all messages and writing concise; say each thing once and don't recap work I already know about.
- Delete clearly promotional email without asking; show borderline messages and ask.
${BRIEF}
Recent tasks (newest first; what each found):
- Daily spam cleanup of the inbox: cleaned the work inbox; asked for a yes to read the personal Gmail.`;
const CASES = {
  nov9_emoji_files: {
    turn: { brief: REAL, channel: "imessage", thread: [{ role: "caller", text: "Everytime I get an email can you mark it as read? If it requires an action or is from someone important like my wife, leave it unread and text me a quick summary" }], shape: { form: "emoji", link: false }, pending: ["issue 515, draft d1: May I read your personal Gmail (ezra.vega@gmail.example) for the daily spam cleanup too?"], open: ["issue 515, waiting for their yes, 15 h: Every day, clean spam out of my inboxes"], timezone: "America/Los_Angeles" },
    ok: (calls, reply) => calls.some((c) => c.startsWith("file")),
  },
  request_files_eyes: {
    turn: { brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }], timezone: "America/Los_Angeles" },
    ok: (calls, reply) => calls.some((c) => c.startsWith("file")) && calls.includes("react eyes") && !reply.trim(),
  },
  status_honest: {
    turn: { brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Research how divorce probability changes with jobs where you travel 4+ months a year" }, { role: "caller", text: "Is it done yet?" }], open: ["issue 493, in progress for 13 h, its worker got stuck 26 times: Research how divorce probability changes with jobs where you travel 4+ months a year"], timezone: "America/Los_Angeles" },
    // Words, nothing filed again, the delay said (13 hours, snags, longer than expected…), and no "done".
    ok: (calls, reply) => !calls.some((c) => c.startsWith("file")) && /13|hours|stuck|snag|slow|drag|long|delay|struggl|hiccup|roadblock|trouble/i.test(reply) && !/^\W*done\b|here'?s what (i|we) found/i.test(reply),
  },
};
function tools() {
  const calls = [];
  return { calls, t: {
    fileIssue: (r) => (calls.push("file"), "Filed #7."),
    updateIssue: (n) => (calls.push(`update ${n}`), "Updated."),
    confirm: () => (calls.push("confirm"), "Confirmed; it's running."),
    remember: () => (calls.push("remember"), "Noted."),
    react: (r) => (calls.push(`react ${r}`), "Reacted."),
  } };
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
await Promise.all(MODELS.map(async (model) => {
  const talk = textTalker({ apiKey: key, model });
  const out = [];
  for (const [name, c] of Object.entries(CASES)) {
    let pass = 0, errs = 0; const ms = []; const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const { t, calls } = tools();
      const t0 = Date.now();
      try {
        const reply = await talk({ ...c.turn, tools: t });
        ms.push(Date.now() - t0);
        if (c.ok(calls, reply)) pass++; else samples.push(`${calls.join(",")} | ${reply.slice(0, 80)}`);
      } catch (e) { errs++; samples.push(`ERR ${e.message}`); }
    }
    out.push(`  ${name.padEnd(20)} ${pass}/${RUNS}  median ${ms.length ? (med(ms) / 1000).toFixed(1) : "-"} s${errs ? `  errors ${errs}` : ""}${samples.length ? `\n      miss: ${samples[0]}` : ""}`);
  }
  console.log(`${model}\n${out.join("\n")}`);
}));
