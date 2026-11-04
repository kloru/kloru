/**
 * /start: what a new family does first, in order. Each step says what it's for, links to the page
 * that does it, and ticks once Kloru sees it done (from the agent's setup.status).
 */
import { esc } from "./html.js";
import { formatPhone } from "./pages.js";

export interface SetupStatus {
  apps: string[];
  family: number;
  texting: { number?: string; handle?: string; texted?: string; sent?: string };
  vault: number;
  policy: boolean;
  conversations: number;
}

interface Step {
  done: boolean;
  title: string;
  why: string;
  action: string;
  optional?: boolean;
}

function steps(s: SetupStatus, owner: boolean): Step[] {
  const texted = !!(s.texting.texted || s.texting.sent);
  const optIn = s.texting.handle ? `connect @${s.texting.handle}` : "";
  const textLink = s.texting.number ? `<a href="sms:${esc(s.texting.number)}${optIn ? `&amp;body=${encodeURIComponent(optIn)}` : ""}">${optIn ? `text <b>${esc(optIn)}</b> to ${esc(formatPhone(s.texting.number))}` : `text ${esc(formatPhone(s.texting.number))}`}</a>` : "";
  return [
    { done: s.apps.some((a) => /gmail|googlecalendar/.test(a)), title: "Connect your email and calendar", why: "So Kloru can find things in your inbox and keep your calendar right.", action: `<a href="/connections">Connect Gmail and Google Calendar</a>` },
    ...(owner ? [{ done: s.family > 0, title: "Add your family", why: "Each person can text Kloru for themselves, and you say what they may see and do.", action: `<a href="/contacts">Add people</a>` }] : []),
    { done: texted, title: "Turn on texting", why: "Kloru answers by iMessage or text, and tells you when things are done.", action: textLink ? `From your phone, ${textLink}.` : `<a href="/connections">See how to text Kloru</a>` },
    { done: s.conversations > 0, title: "Ask Kloru for something", why: "Try \"what's on my calendar tomorrow?\" or \"find a dentist near us\".", action: s.texting.number ? `Text ${esc(formatPhone(s.texting.number))}.` : "Text or call Kloru." },
    { done: s.vault > 0, title: "Save a card, if you want Kloru to buy things", why: "Use a card with limits you control. Kloru uses it by name and never sees the number.", action: `<a href="/vault">Open the Vault</a>`, optional: true },
    { done: s.policy, title: "Say what others may do with your things", why: "Anything you don't mention is open to your family. You can also just tell Kloru.", action: `<a href="/policy">Your policy</a>`, optional: true },
  ];
}

/** The required steps are done: the page steps aside. */
export function setupDone(s: SetupStatus, owner: boolean): boolean {
  return steps(s, owner).every((x) => x.done || x.optional);
}

export function startPage(s: SetupStatus, owner: boolean, name: string): string {
  const list = steps(s, owner);
  const left = list.filter((x) => !x.done && !x.optional).length;
  const first = name.split(/\s+/)[0] ?? "";
  return (
    `<section class="prose"><p class="lead">${first ? `Welcome, ${esc(first)}` : "Welcome"}</p><p>${left ? `${left} step${left === 1 ? "" : "s"} to go. Each takes a minute.` : "You're set. The rest is optional."}</p></section>` +
    `<ol class="start">${list
      .map((x) => `<li class="${x.done ? "done" : ""}"><span class="state${x.done ? " ok" : ""}">${x.done ? "Done" : x.optional ? "Optional" : "To do"}</span> <b>${esc(x.title)}</b><p>${esc(x.why)}</p>${x.done ? "" : `<p>${x.action}</p>`}</li>`)
      .join("")}</ol>`
  );
}
