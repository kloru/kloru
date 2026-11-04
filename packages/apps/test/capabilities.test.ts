import { describe, expect, it } from "vitest";
import { PolicyEngine, defaultPolicy } from "@kloru/core";
import type { Principal, Tier } from "@kloru/core";
import { APPS_MANAGE, CONTACTS_WRITE, PAYMENT_TOOLKITS, capabilitiesForSlug, sensitiveCapabilitiesForSlug, toolkitOfSlug, COMPOSIO_META_TOOLS } from "../src/capabilities.js";
import { metaFor } from "../src/wrap.js";

describe("capabilitiesForSlug", () => {
  it.each([
    ["GMAIL_SEND_EMAIL", ["email.send"]],
    ["GMAIL_REPLY_TO_THREAD", ["email.send"]],
    ["GMAIL_CREATE_EMAIL_DRAFT", ["email.send"]],
    ["GMAIL_FORWARD_MESSAGE", ["email.send"]],
    ["GMAIL_FORWARD", ["email.send"]],
    ["GMAIL_FETCH_EMAILS", ["email.read"]],
    ["GMAIL_GET_PROFILE", ["email.read"]],
    ["GMAIL_LIST_LABELS", ["email.read"]],
    ["GOOGLECALENDAR_CREATE_EVENT", ["calendar.write"]],
    ["GOOGLECALENDAR_UPDATE_EVENT", ["calendar.write"]],
    ["GOOGLECALENDAR_DELETE_EVENT", ["calendar.write"]],
    ["GOOGLECALENDAR_PATCH_EVENT", ["calendar.write"]],
    ["GOOGLECALENDAR_QUICK_ADD", ["calendar.write"]],
    ["GOOGLECALENDAR_FIND_FREE_SLOTS", ["calendar.freebusy"]],
    ["GOOGLECALENDAR_FREEBUSY", ["calendar.freebusy"]],
    ["GOOGLECALENDAR_GET_FREE_BUSY", ["calendar.freebusy"]],
    ["GOOGLECALENDAR_EVENTS_LIST", ["calendar.read"]],
    ["GOOGLECALENDAR_FIND_EVENT", ["calendar.read"]],
    ["GOOGLECALENDAR_GET_CALENDAR", ["calendar.read"]],
    ["GOOGLECONTACTS_SEARCH_CONTACTS", ["contacts.read"]],
    ["GOOGLECONTACTS_LIST_CONTACTS", ["contacts.read"]],
    ["GOOGLECONTACTS_GET_CONTACT", ["contacts.read"]],
    ["GOOGLECONTACTS_CREATE_CONTACT", CONTACTS_WRITE],
    ["GOOGLECONTACTS_UPDATE_CONTACT", CONTACTS_WRITE],
    ["GOOGLECONTACTS_DELETE_CONTACT", CONTACTS_WRITE],
    ["GOOGLECONTACTS_BATCH_UPDATE_CONTACTS", CONTACTS_WRITE],
    ["GOOGLECONTACTS_BATCH_DELETE_CONTACTS", CONTACTS_WRITE],
    ["GOOGLECONTACTS_MODIFY_CONTACT_GROUP_MEMBERS", CONTACTS_WRITE],
    ["COMPOSIO_MANAGE_CONNECTIONS", APPS_MANAGE],
    ["COMPOSIO_SEARCH_TOOLS", APPS_MANAGE],
    ["COMPOSIO_MULTI_EXECUTE_TOOL", APPS_MANAGE],
    ["NOTION_CREATE_PAGE", APPS_MANAGE],
    ["GITHUB_CREATE_ISSUE", APPS_MANAGE],
    ["GITHUB_DELETE_REPOSITORY", APPS_MANAGE],
    ["LINEAR_UPDATE_ISSUE", APPS_MANAGE],
    ["", APPS_MANAGE],
  ] as const)("%s -> %j", (slug, expected) => {
    expect(capabilitiesForSlug(slug)).toEqual([...expected]);
  });

  /**
   * Toolkits without a row stay owner-only (APPS_MANAGE) and gain a stricter tag when
   * the slug sends, changes a calendar or moves money. Reads never gain a tag.
   */
  it.each([
    ["SLACK_SEND_MESSAGE", ["email.send", ...APPS_MANAGE]],
    ["DISCORD_SEND_MESSAGE", ["email.send", ...APPS_MANAGE]],
    ["TWILIO_SEND_SMS", ["email.send", ...APPS_MANAGE]],
    ["ZOHOMAIL_SEND_EMAIL", ["email.send", ...APPS_MANAGE]],
    ["ZOHOMAIL_REPLY_EMAIL", ["email.send", ...APPS_MANAGE]],
    ["SENDGRID_SEND_EMAIL", ["email.send", ...APPS_MANAGE]],
    ["ZOHOMAIL_CREATE_DRAFT_EMAIL", ["email.send", ...APPS_MANAGE]],
    ["ZOHOMAIL_LIST_MESSAGES", APPS_MANAGE],
    ["SLACK_LIST_CHANNELS", APPS_MANAGE],
    ["SENDGRID_GET_STATS", APPS_MANAGE],
    ["ZOHOMAIL_CALENDAR_CREATE_EVENT", ["calendar.write", ...APPS_MANAGE]],
    ["CALENDLY_CANCEL_EVENT", ["calendar.write", ...APPS_MANAGE]],
    ["ZOOM_CREATE_MEETING", ["calendar.write", ...APPS_MANAGE]],
    ["ZOHOMAIL_CALENDAR_LIST_EVENTS", APPS_MANAGE],
    ["POSTHOG_CAPTURE_EVENT", APPS_MANAGE],
    ["STRIPE_CREATE_PAYMENT_INTENT", ["purchase", ...APPS_MANAGE]],
    ["STRIPE_CREATE_CUSTOMER", ["purchase", ...APPS_MANAGE]],
    ["STRIPE_LIST_CUSTOMERS", APPS_MANAGE],
    ["STRIPE_GET_PAYMENT_INTENT", APPS_MANAGE],
    ["PAYPAL_CREATE_PAYOUT", ["purchase", ...APPS_MANAGE]],
    ["SHOPIFY_CREATE_ORDER", ["purchase", ...APPS_MANAGE]],
    ["SHOPIFY_CANCEL_ORDER", ["purchase", ...APPS_MANAGE]],
    ["SHOPIFY_GET_ORDER", APPS_MANAGE],
    ["SHOPIFY_UPDATE_PRODUCT", APPS_MANAGE],
    ["WISE_CREATE_TRANSFER", ["purchase", ...APPS_MANAGE]],
    ["WISE_LIST_TRANSFERS", APPS_MANAGE],
    ["COINBASE_SEND_TRANSACTION", ["email.send", "purchase", ...APPS_MANAGE]],
    ["AMAZON_CHECKOUT_CART", ["purchase", ...APPS_MANAGE]],
    ["NOTION_UPDATE_PAGE", APPS_MANAGE],
  ] as const)("unknown toolkit %s -> %j", (slug, expected) => {
    expect(capabilitiesForSlug(slug)).toEqual([...expected]);
  });

  it("is case and whitespace insensitive", () => {
    expect(capabilitiesForSlug(" gmail_send_email ")).toEqual(["email.send"]);
    expect(capabilitiesForSlug("googlecalendar_create_event")).toEqual(["calendar.write"]);
    expect(capabilitiesForSlug("googlecontacts_delete_contact")).toEqual([...CONTACTS_WRITE]);
  });

  it("does not treat a lookalike toolkit as Gmail", () => {
    expect(capabilitiesForSlug("GMAILX_SEND_EMAIL")).toEqual(["email.send", ...APPS_MANAGE]);
    expect(capabilitiesForSlug("MYGMAIL_FETCH")).toEqual([...APPS_MANAGE]);
  });

  it("always keeps the owner-only pair on an unknown toolkit, however sensitive", () => {
    for (const slug of ["SLACK_SEND_MESSAGE", "STRIPE_CREATE_CHARGE", "ZOOM_CREATE_MEETING", "NOTION_CREATE_PAGE", "ACME_DO_THING"]) {
      const caps = capabilitiesForSlug(slug);
      expect(caps, slug).toContain("apps.use");
      expect(caps, slug).toContain("trust.manage");
    }
  });

  it("maps every meta tool to the owner-only set", () => {
    for (const slug of COMPOSIO_META_TOOLS) expect(capabilitiesForSlug(slug)).toEqual([...APPS_MANAGE]);
  });

  it("returns a fresh array each time so callers cannot mutate the table", () => {
    const a = capabilitiesForSlug("NOTION_CREATE_PAGE");
    a.push("email.send");
    expect(capabilitiesForSlug("NOTION_CREATE_PAGE")).toEqual([...APPS_MANAGE]);
  });
});

describe("sensitiveCapabilitiesForSlug", () => {
  it("returns nothing for a bare toolkit or a read", () => {
    expect(sensitiveCapabilitiesForSlug("STRIPE")).toEqual([]);
    expect(sensitiveCapabilitiesForSlug("STRIPE_LIST_CHARGES")).toEqual([]);
    expect(sensitiveCapabilitiesForSlug("slack_search_messages")).toEqual([]);
  });

  it("treats every write in a payment toolkit as a purchase", () => {
    for (const toolkit of PAYMENT_TOOLKITS) {
      expect(sensitiveCapabilitiesForSlug(`${toolkit}_CREATE_THING`), toolkit).toEqual(["purchase"]);
      expect(sensitiveCapabilitiesForSlug(`${toolkit}_LIST_THINGS`), toolkit).toEqual([]);
    }
  });

  it("does not let a toolkit name trigger a verb match", () => {
    // SENDGRID contains SEND, but only the action words count.
    expect(sensitiveCapabilitiesForSlug("SENDGRID_CREATE_TEMPLATE")).toEqual([]);
    expect(sensitiveCapabilitiesForSlug("PAYHIP_UPDATE_PRODUCT")).toEqual([]);
  });
});

/**
 * The safety argument of this package: with core's default tier table, meta tools,
 * unknown toolkits and contact writes are owner-only. These tests fail if core
 * widens a tier or this table drops the owner-only tag.
 */
describe("policy outcomes with the default tier table", () => {
  const engine = new PolicyEngine(defaultPolicy());
  const principalFor = (tier: Tier): Principal =>
    tier === "owner"
      ? { kind: "owner", id: "owner", tier, displayName: "Maria" }
      : { kind: tier === "stranger" ? "stranger" : "contact", id: `contact:${tier}`, tier, displayName: tier };
  const nonOwners: Tier[] = ["partner", "family", "friend", "contact", "stranger"];
  const ownerOnlySlugs = [
    "COMPOSIO_MULTI_EXECUTE_TOOL",
    "COMPOSIO_MANAGE_CONNECTIONS",
    "COMPOSIO_SEARCH_TOOLS",
    "SLACK_SEND_MESSAGE",
    "NOTION_CREATE_PAGE",
    "STRIPE_LIST_CUSTOMERS",
    "ZOOM_CREATE_MEETING",
    "GOOGLECONTACTS_CREATE_CONTACT",
    "GOOGLECONTACTS_UPDATE_CONTACT",
    "GOOGLECONTACTS_DELETE_CONTACT",
    "GOOGLECONTACTS_BATCH_UPDATE_CONTACTS",
  ];

  it.each(ownerOnlySlugs)("%s is denied for every non-owner tier and allowed for the owner", (slug) => {
    const meta = metaFor(slug);
    for (const tier of nonOwners) {
      const decision = engine.evaluate(principalFor(tier), meta, {});
      expect(decision.outcome, `${slug} for ${tier}`).toBe("deny");
    }
    expect(engine.evaluate(principalFor("owner"), meta, {}).outcome).toBe("allow");
  });

  it("a batch call is judged by each action in it: Cara with a calendar grant books, but can't read Evan's mail", () => {
    const granted = new PolicyEngine(defaultPolicy());
    const family = principalFor("family");
    granted.addGrant({ to: family.id, capabilities: ["calendar.write"], note: "member" });
    const meta = metaFor("COMPOSIO_MULTI_EXECUTE_TOOL");
    const batch = (...slugs: string[]) => ({ tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) });
    expect(granted.evaluate(family, meta, batch("GOOGLECALENDAR_CREATE_EVENT")).outcome).toBe("allow");
    expect(granted.evaluate(family, meta, batch("GOOGLECALENDAR_CREATE_EVENT", "GMAIL_FETCH_EMAILS")).outcome).toBe("deny");
    expect(granted.evaluate(family, meta, batch("COMPOSIO_MANAGE_CONNECTIONS")).outcome).toBe("deny");
    expect(granted.evaluate(family, meta, { tools: "not a list" }).outcome).toBe("deny");
  });

  it("a payment-like app action asks the owner because no amount is known, and is denied to everyone else", () => {
    for (const slug of ["STRIPE_CREATE_PAYMENT_INTENT", "SHOPIFY_CREATE_ORDER", "WISE_CREATE_TRANSFER"]) {
      const meta = metaFor(slug);
      expect(engine.evaluate(principalFor("owner"), meta, {}).outcome, slug).toBe("ask");
      for (const tier of nonOwners) expect(engine.evaluate(principalFor(tier), meta, {}).outcome, `${slug} for ${tier}`).toBe("deny");
    }
  });

  it("a grant on the owner-only pair alone does not open a payment or a send", () => {
    const granted = new PolicyEngine(defaultPolicy());
    const partner = principalFor("partner");
    granted.addGrant({ to: partner.id, capabilities: ["apps.use", "trust.manage"], note: "test" });
    expect(granted.evaluate(partner, metaFor("NOTION_CREATE_PAGE"), {}).outcome).toBe("allow");
    expect(granted.evaluate(partner, metaFor("STRIPE_CREATE_CHARGE"), {}).outcome).not.toBe("allow");
    expect(granted.evaluate(partner, metaFor("SLACK_SEND_MESSAGE"), {}).outcome).not.toBe("allow");
  });

  it("the stopgap tags really are owner-only in core's table", () => {
    for (const tier of nonOwners) {
      expect(engine.permissionFor(tier, "trust.manage")).toBe("no");
      expect(engine.permissionFor(tier, "memory.write")).toBe("no");
    }
  });

  it("a partner can still read contacts and a friend can still check free/busy", () => {
    expect(engine.evaluate(principalFor("partner"), metaFor("GOOGLECONTACTS_SEARCH_CONTACTS"), {}).outcome).toBe("allow");
    expect(engine.evaluate(principalFor("friend"), metaFor("GOOGLECALENDAR_FIND_FREE_SLOTS"), {}).outcome).toBe("allow");
    expect(engine.evaluate(principalFor("friend"), metaFor("GMAIL_FETCH_EMAILS"), {}).outcome).toBe("deny");
  });
});

describe("toolkitOfSlug", () => {
  it("takes the prefix before the first underscore, lowercased", () => {
    expect(toolkitOfSlug("GMAIL_SEND_EMAIL")).toBe("gmail");
    expect(toolkitOfSlug("googlecalendar_create_event")).toBe("googlecalendar");
    expect(toolkitOfSlug("NOUNDERSCORE")).toBe("nounderscore");
  });

  it("knows toolkits whose own slug has an underscore", () => {
    expect(toolkitOfSlug("ONE_DRIVE_UPLOAD_FILE")).toBe("one_drive");
    expect(toolkitOfSlug("MICROSOFT_TEAMS_SEND_MESSAGE")).toBe("microsoft_teams");
    expect(toolkitOfSlug("ONENOTE_GET_PAGE")).toBe("onenote");
  });
});

describe("Outlook: mail and calendar, like Gmail and Google Calendar", () => {
  it.each([
    ["OUTLOOK_OUTLOOK_SEND_EMAIL", ["email.send"]],
    ["OUTLOOK_OUTLOOK_REPLY_EMAIL", ["email.send"]],
    ["OUTLOOK_OUTLOOK_CREATE_DRAFT", ["email.send"]],
    ["OUTLOOK_OUTLOOK_CREATE_DRAFT_REPLY", ["email.send"]],
    ["OUTLOOK_OUTLOOK_LIST_MESSAGES", ["email.read"]],
    ["OUTLOOK_OUTLOOK_SEARCH_MESSAGES", ["email.read"]],
    ["OUTLOOK_OUTLOOK_GET_PROFILE", ["email.read"]],
    ["OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", ["email.read"]],
    ["OUTLOOK_OUTLOOK_GET_SCHEDULE", ["calendar.freebusy"]],
    ["OUTLOOK_OUTLOOK_LIST_EVENTS", ["calendar.read"]],
    ["OUTLOOK_LIST_CALENDARS", ["calendar.read"]],
    ["OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT", ["calendar.write"]],
    ["OUTLOOK_OUTLOOK_UPDATE_CALENDAR_EVENT", ["calendar.write"]],
    ["OUTLOOK_OUTLOOK_DELETE_EVENT", ["calendar.write"]],
    ["OUTLOOK_OUTLOOK_LIST_CONTACTS", ["contacts.read"]],
    ["OUTLOOK_OUTLOOK_CREATE_CONTACT", [...CONTACTS_WRITE]],
  ])("%s needs %j", (slug, caps) => {
    expect(capabilitiesForSlug(slug)).toEqual(caps);
  });

  it("changing the mailbox itself (rules, settings, moving mail) stays the owner's", () => {
    for (const slug of ["OUTLOOK_CREATE_EMAIL_RULE", "OUTLOOK_UPDATE_MAILBOX_SETTINGS", "OUTLOOK_OUTLOOK_MOVE_MESSAGE", "OUTLOOK_DELETE_MAIL_FOLDER", "OUTLOOK_OUTLOOK_UPDATE_EMAIL"]) {
      expect(capabilitiesForSlug(slug), slug).toEqual(expect.arrayContaining([...APPS_MANAGE]));
    }
  });
});

describe("staff tier with app tools", () => {
  const engine = new PolicyEngine(defaultPolicy());
  const staff: Principal = { kind: "agent", id: "agent:research-bot", tier: "staff", displayName: "Research's agent", agentHandle: "research-bot" };

  it("gets the owner's working app tools", () => {
    expect(engine.evaluate(staff, metaFor("GOOGLECALENDAR_FIND_FREE_SLOTS"), {}).outcome).toBe("allow");
    expect(engine.evaluate(staff, metaFor("GMAIL_FETCH_EMAILS"), {}).outcome).toBe("allow");
    expect(engine.evaluate(staff, metaFor("GOOGLECONTACTS_SEARCH_CONTACTS"), {}).outcome).toBe("allow");
  });

  it("asks the owner for sends and calendar writes", () => {
    expect(engine.evaluate(staff, metaFor("GMAIL_SEND_EMAIL"), {}).outcome).toBe("ask");
    expect(engine.evaluate(staff, metaFor("GOOGLECALENDAR_CREATE_EVENT"), {}).outcome).toBe("ask");
  });

  it("is still denied the owner-only pair, so non-Google toolkits and payments stay with the owner", () => {
    expect(engine.evaluate(staff, metaFor("NOTION_CREATE_PAGE"), {}).outcome).toBe("deny");
    expect(engine.evaluate(staff, metaFor("GOOGLECONTACTS_CREATE_CONTACT"), {}).outcome).toBe("deny");
    expect(engine.evaluate(staff, metaFor("STRIPE_CREATE_PAYMENT_INTENT"), {}).outcome).toBe("deny");
  });
});
