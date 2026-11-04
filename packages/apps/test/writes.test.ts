import { describe, expect, it } from "vitest";
import { callNotifiesSomeone, innerCalls, isReadSlug, isWriteCall } from "../src/writes.js";

const bulk = (...tools: Array<[string, Record<string, unknown>?]>) => ({ tools: tools.map(([tool_slug, args]) => ({ tool_slug, arguments: args ?? {} })) });

describe("read and write calls", () => {
  it("a slug is a read only when it names a read and no write", () => {
    for (const s of ["GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]) expect(isReadSlug(s), s).toBe(true);
    for (const s of ["GOOGLECALENDAR_CREATE_EVENT", "GMAIL_MOVE_TO_TRASH", "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_SEND_EMAIL", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_REMOTE_BASH_TOOL", "NOTION_CREATE_PAGE", "GMAIL_LIST_AND_DELETE"]) expect(isReadSlug(s), s).toBe(false);
  });

  it("finds the calls inside Composio's bulk execute and in direct app tools", () => {
    expect(innerCalls("app_composio_multi_execute_tool", bulk(["GMAIL_FETCH_EMAILS", { q: "x" }], ["GOOGLECALENDAR_CREATE_EVENT"]))).toEqual([
      { slug: "GMAIL_FETCH_EMAILS", args: { q: "x" } },
      { slug: "GOOGLECALENDAR_CREATE_EVENT", args: {} },
    ]);
    expect(innerCalls("app_gmail_send_email", { to: "a@b.c" })).toEqual([{ slug: "GMAIL_SEND_EMAIL", args: { to: "a@b.c" } }]);
    expect(innerCalls("memory_read", {})).toEqual([]);
  });

  it("a bulk execute is a write if any inner call writes, or if its contents can't be read", () => {
    expect(isWriteCall("app_composio_multi_execute_tool", bulk(["GMAIL_FETCH_EMAILS"]))).toBe(false);
    expect(isWriteCall("app_composio_multi_execute_tool", bulk(["GMAIL_FETCH_EMAILS"], ["GMAIL_MOVE_TO_TRASH"]))).toBe(true);
    expect(isWriteCall("app_composio_multi_execute_tool", { tools: "nonsense" })).toBe(true);
    expect(isWriteCall("app_composio_search_tools", { queries: [] })).toBe(false);
    expect(isWriteCall("memory_read", {})).toBe(false);
  });

  it("only changes that reach another person need a yes", () => {
    expect(callNotifiesSomeone("app_composio_multi_execute_tool", bulk(["GMAIL_SEND_EMAIL", { to: "sam@x.com" }]))).toBe(true);
    expect(callNotifiesSomeone("app_gmail_reply_to_thread", {})).toBe(true);
    expect(callNotifiesSomeone("app_gmail_forward_message", {})).toBe(true);
    expect(callNotifiesSomeone("app_gmail_create_email_draft", {})).toBe(false);
    expect(callNotifiesSomeone("app_gmail_move_to_trash", {})).toBe(false);
    expect(callNotifiesSomeone("app_googlecalendar_create_event", { summary: "Coffee" })).toBe(false);
    expect(callNotifiesSomeone("app_googlecalendar_create_event", { summary: "Coffee", attendees: ["sam@x.com"] })).toBe(true);
    expect(callNotifiesSomeone("app_googlecalendar_update_event", { attendees: [], send_updates: "none" })).toBe(false);
    expect(callNotifiesSomeone("app_slack_send_message", {})).toBe(true);
    expect(callNotifiesSomeone("app_stripe_create_refund", {})).toBe(true);
  });
});

describe("review: stricter classification", () => {
  it("more verbs make a write, and a read verb next to one doesn't make it a read", () => {
    for (const s of ["GOOGLEDOCS_FIND_REPLACE_TEXT", "NOTION_SEARCH_AND_REPLACE", "GOOGLEDRIVE_UPLOAD_FILE", "GOOGLEDRIVE_SHARE_FILE", "HUBSPOT_UPSERT_CONTACT", "SHEETS_APPEND_ROWS", "LINKEDIN_POST_UPDATE", "GOOGLECALENDAR_RSVP_EVENT", "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL"]) expect(isReadSlug(s), s).toBe(false);
  });

  it("calendar changes and deletes tell the guests unless the call says not to", () => {
    expect(callNotifiesSomeone("app_googlecalendar_update_event", { event_id: "ev_9", summary: "Coffee" })).toBe(true);
    expect(callNotifiesSomeone("app_googlecalendar_delete_event", { event_id: "ev_9" })).toBe(true);
    expect(callNotifiesSomeone("app_googlecalendar_patch_event", { event_id: "ev_9", send_updates: "none" })).toBe(false);
    expect(callNotifiesSomeone("app_googlecalendar_delete_event", { event_id: "ev_9", send_updates: false })).toBe(false);
    expect(callNotifiesSomeone("app_googlecalendar_delete_event", { event_id: "ev_9", sendUpdates: "none" })).toBe(false);
    expect(callNotifiesSomeone("app_googlecalendar_create_event", { summary: "x", send_updates: "none", attendees: ["a@b.c"] })).toBe(true);
  });

  it("any write outside Gmail, Calendar and Contacts counts as reaching someone; contacts edits don't", () => {
    expect(callNotifiesSomeone("app_slack_sends_a_message_to_a_slack_channel", {})).toBe(true);
    expect(callNotifiesSomeone("app_notion_create_page", {})).toBe(true);
    expect(callNotifiesSomeone("app_googlecontacts_create_contact", {})).toBe(false);
    expect(callNotifiesSomeone("app_notion_search_pages", {})).toBe(false);
  });
});
