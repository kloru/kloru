import { describe, expect, it } from "vitest";
import { accountScope, accountsLine } from "../src/account-scope.js";

const EVAN = "+14155550190";
const CARA = "+14155550191";
const ACCOUNTS = [
  { id: "ca_evan_mail", toolkit: "gmail", email: "evan@gmail.com", status: "connected" as const },
  { id: "ca_evan_cal", toolkit: "googlecalendar", email: "evan@gmail.com", status: "connected" as const },
  { id: "ca_cara_mail", toolkit: "gmail", email: "cara@gmail.com", person: "cara", status: "connected" as const },
];

function scope(caraMay: string[], caraOwns = false) {
  return accountScope({
    accounts: () => ACCOUNTS,
    isOwner: (p) => p === EVAN || (caraOwns && p === CARA),
    personOf: (p) => (p === CARA && !caraOwns ? { id: "cara", may: (cap) => caraMay.includes(cap) } : undefined),
    selfOf: (p) => (p === CARA ? "cara" : undefined),
  });
}

describe("which accounts a caller may use", () => {
  it("Evan: his own accounts, never a member's; her mail stays hers", () => {
    const s = scope([])(EVAN);
    expect(s.accounts.map((a) => a.id)).toEqual(["ca_evan_mail", "ca_evan_cal"]);
    expect(s.mail).toEqual(["evan@gmail.com"]);
    expect(s.restricted).toEqual(["gmail"]);
  });

  it("co-owners share their accounts, each their own first, and must name one where there are two", () => {
    const co = accountScope({ accounts: () => ACCOUNTS, isOwner: (p) => p === EVAN || p === CARA, personOf: () => undefined, selfOf: (p) => (p === CARA ? "cara" : undefined), ownerPerson: (id) => id === "cara" });
    const evan = co(EVAN);
    expect(evan.accounts.map((a) => a.id)).toEqual(["ca_evan_mail", "ca_evan_cal", "ca_cara_mail"]);
    expect(evan.mail.sort()).toEqual(["cara@gmail.com", "evan@gmail.com"]);
    expect(evan.restricted).toEqual(["gmail"]);
    const cara = co(CARA);
    expect(cara.accounts.map((a) => a.id)).toEqual(["ca_cara_mail", "ca_evan_mail", "ca_evan_cal"]);
    expect(cara.calendar).toEqual(["evan@gmail.com"]);
  });

  it("Cara with everything: her own and Evan's, and she reads both mailboxes", () => {
    const s = scope(["email.read", "email.send", "calendar.read", "calendar.write"])(CARA);
    expect(s.accounts.map((a) => a.id).sort()).toEqual(["ca_cara_mail", "ca_evan_cal", "ca_evan_mail"]);
    expect(s.mail.sort()).toEqual(["cara@gmail.com", "evan@gmail.com"]);
  });

  it("Cara with only his calendar: her own mail and his calendar, none of his mail", () => {
    const s = scope(["calendar.read"])(CARA);
    expect(s.accounts.map((a) => a.id).sort()).toEqual(["ca_cara_mail", "ca_evan_cal"]);
    expect(s.mail).toEqual(["cara@gmail.com"]);
    expect(s.restricted.sort()).toEqual(["gmail"]);
  });

  it("anyone who calls, when Evan opened his calendar to them: his calendar only, never any mail", () => {
    const s = accountScope({ accounts: () => ACCOUNTS, isOwner: (p) => p === EVAN, personOf: () => ({ id: "", may: (c) => c === "calendar.write" || c === "calendar.freebusy" }) })("+14155550123");
    expect(s.accounts.map((a) => a.id)).toEqual(["ca_evan_cal"]);
    expect(s.mail).toEqual([]);
  });

  it("calendars: Evan sees his own in full; a caller who may only see free time gets busy blocks; one with nothing gets none", () => {
    expect(scope([])(EVAN)).toMatchObject({ calendar: ["evan@gmail.com"], busy: [] });
    expect(scope(["calendar.read"])(CARA)).toMatchObject({ calendar: ["evan@gmail.com"], busy: [] });
    expect(scope(["calendar.freebusy", "calendar.write"])(CARA)).toMatchObject({ calendar: [], busy: ["evan@gmail.com"] });
    expect(scope([])(CARA)).toMatchObject({ calendar: [], busy: [] });
  });

  it("someone who isn't family uses nothing", () => {
    expect(scope([])("+14155550100")).toEqual({ accounts: [], mail: [], calendar: [], busy: [], restricted: ["gmail", "googlecalendar"] });
  });

  it("her workers are told only her accounts, and to name one", () => {
    const line = accountsLine(scope(["calendar.read"])(CARA));
    expect(line).toContain("cara@gmail.com (account ca_cara_mail)");
    expect(line).not.toContain("ca_evan_mail");
    expect(accountsLine(accountScope({ accounts: () => ACCOUNTS.slice(0, 2), isOwner: () => true, personOf: () => undefined })(EVAN))).toBe("");
  });

  describe("apps beyond Google", () => {
    const MORE = [
      ...ACCOUNTS,
      { id: "ca_evan_outlook", toolkit: "outlook", email: "evan@outlook.com", status: "connected" as const },
      { id: "ca_evan_notion", toolkit: "notion", status: "connected" as const },
      { id: "ca_cara_notion", toolkit: "notion", person: "cara", status: "connected" as const },
    ];
    const more = (caraMay: string[]) => accountScope({ accounts: () => MORE, isOwner: (p) => p === EVAN, personOf: (p) => (p === CARA ? { id: "cara", may: (cap) => caraMay.includes(cap) } : undefined) });

    it("Evan's Outlook is mail and calendar: Cara uses it only when his words gave her one of those", () => {
      expect(more([])(CARA).accounts.map((a) => a.id)).not.toContain("ca_evan_outlook");
      expect(more(["calendar.read"])(CARA).accounts.map((a) => a.id)).toContain("ca_evan_outlook");
    });

    it("an app with no email address still tells the workers which account is whose", () => {
      const line = accountsLine(more([])(EVAN));
      expect(line).toContain("Notion: account ca_evan_notion");
      expect(line).not.toContain("ca_cara_notion");
    });
  });
});
