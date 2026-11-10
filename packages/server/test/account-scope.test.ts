import { describe, expect, it } from "vitest";
import { accountScope, accountsLine } from "../src/account-scope.js";

const EZRA = "+14155550190";
const CLEO = "+14155550191";
const ACCOUNTS = [
  { id: "ca_ezra_mail", toolkit: "gmail", email: "ezra@gmail.example", status: "connected" as const },
  { id: "ca_ezra_cal", toolkit: "googlecalendar", email: "ezra@gmail.example", status: "connected" as const },
  { id: "ca_cleo_mail", toolkit: "gmail", email: "cleo@gmail.example", person: "cleo", status: "connected" as const },
];

function scope(cleoMay: string[], cleoOwns = false) {
  return accountScope({
    accounts: () => ACCOUNTS,
    isOwner: (p) => p === EZRA || (cleoOwns && p === CLEO),
    personOf: (p) => (p === CLEO && !cleoOwns ? { id: "cleo", may: (cap) => cleoMay.includes(cap) } : undefined),
    selfOf: (p) => (p === CLEO ? "cleo" : undefined),
  });
}

describe("which accounts a caller may use", () => {
  it("Ezra: his own accounts, never a member's; her mail stays hers", () => {
    const s = scope([])(EZRA);
    expect(s.accounts.map((a) => a.id)).toEqual(["ca_ezra_mail", "ca_ezra_cal"]);
    expect(s.mail).toEqual(["ezra@gmail.example"]);
    expect(s.restricted).toEqual(["gmail"]);
  });

  it("co-owners share their accounts, each their own first, and must name one where there are two", () => {
    const co = accountScope({ accounts: () => ACCOUNTS, isOwner: (p) => p === EZRA || p === CLEO, personOf: () => undefined, selfOf: (p) => (p === CLEO ? "cleo" : undefined), ownerPerson: (id) => id === "cleo" });
    const ezra = co(EZRA);
    expect(ezra.accounts.map((a) => a.id)).toEqual(["ca_ezra_mail", "ca_ezra_cal", "ca_cleo_mail"]);
    expect(ezra.mail.sort()).toEqual(["cleo@gmail.example", "ezra@gmail.example"]);
    expect(ezra.restricted).toEqual(["gmail"]);
    const cleo = co(CLEO);
    expect(cleo.accounts.map((a) => a.id)).toEqual(["ca_cleo_mail", "ca_ezra_mail", "ca_ezra_cal"]);
    expect(cleo.calendar).toEqual(["ezra@gmail.example"]);
  });

  it("Cleo with everything: her own and Ezra's, and she reads both mailboxes", () => {
    const s = scope(["email.read", "email.send", "calendar.read", "calendar.write"])(CLEO);
    expect(s.accounts.map((a) => a.id).sort()).toEqual(["ca_cleo_mail", "ca_ezra_cal", "ca_ezra_mail"]);
    expect(s.mail.sort()).toEqual(["cleo@gmail.example", "ezra@gmail.example"]);
  });

  it("Cleo with only his calendar: her own mail and his calendar, none of his mail", () => {
    const s = scope(["calendar.read"])(CLEO);
    expect(s.accounts.map((a) => a.id).sort()).toEqual(["ca_cleo_mail", "ca_ezra_cal"]);
    expect(s.mail).toEqual(["cleo@gmail.example"]);
    expect(s.restricted.sort()).toEqual(["gmail"]);
  });

  it("anyone who calls, when Ezra opened his calendar to them: his calendar only, never any mail", () => {
    const s = accountScope({ accounts: () => ACCOUNTS, isOwner: (p) => p === EZRA, personOf: () => ({ id: "", may: (c) => c === "calendar.write" || c === "calendar.freebusy" }) })("+14155550123");
    expect(s.accounts.map((a) => a.id)).toEqual(["ca_ezra_cal"]);
    expect(s.mail).toEqual([]);
  });

  it("calendars: Ezra sees his own in full; a caller who may only see free time gets busy blocks; one with nothing gets none", () => {
    expect(scope([])(EZRA)).toMatchObject({ calendar: ["ezra@gmail.example"], busy: [] });
    expect(scope(["calendar.read"])(CLEO)).toMatchObject({ calendar: ["ezra@gmail.example"], busy: [] });
    expect(scope(["calendar.freebusy", "calendar.write"])(CLEO)).toMatchObject({ calendar: [], busy: ["ezra@gmail.example"] });
    expect(scope([])(CLEO)).toMatchObject({ calendar: [], busy: [] });
  });

  it("someone who isn't family uses nothing", () => {
    expect(scope([])("+14155550100")).toEqual({ accounts: [], mail: [], calendar: [], busy: [], restricted: ["gmail", "googlecalendar"] });
  });

  it("her workers are told only her accounts, and to name one", () => {
    const line = accountsLine(scope(["calendar.read"])(CLEO));
    expect(line).toContain("cleo@gmail.example (account ca_cleo_mail)");
    expect(line).not.toContain("ca_ezra_mail");
    expect(accountsLine(accountScope({ accounts: () => ACCOUNTS.slice(0, 2), isOwner: () => true, personOf: () => undefined })(EZRA))).toBe("");
  });

  describe("apps beyond Google", () => {
    const MORE = [
      ...ACCOUNTS,
      { id: "ca_ezra_outlook", toolkit: "outlook", email: "ezra@outlook.example", status: "connected" as const },
      { id: "ca_ezra_notion", toolkit: "notion", status: "connected" as const },
      { id: "ca_cleo_notion", toolkit: "notion", person: "cleo", status: "connected" as const },
    ];
    const more = (cleoMay: string[]) => accountScope({ accounts: () => MORE, isOwner: (p) => p === EZRA, personOf: (p) => (p === CLEO ? { id: "cleo", may: (cap) => cleoMay.includes(cap) } : undefined) });

    it("Ezra's Outlook is mail and calendar: Cleo uses it only when his words gave her one of those", () => {
      expect(more([])(CLEO).accounts.map((a) => a.id)).not.toContain("ca_ezra_outlook");
      expect(more(["calendar.read"])(CLEO).accounts.map((a) => a.id)).toContain("ca_ezra_outlook");
    });

    it("an app with no email address still tells the workers which account is whose", () => {
      const line = accountsLine(more([])(EZRA));
      expect(line).toContain("Notion: account ca_ezra_notion");
      expect(line).not.toContain("ca_cleo_notion");
    });
  });
});
