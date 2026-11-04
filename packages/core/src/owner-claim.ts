/**
 * Claiming an agent that was handed out before its owner's phone was known.
 *
 * A front door that asks only for a name sets `owner.claimOnFirstContact` and a
 * one-time `owner.claimCode` that it shows to the person who signed up, and to
 * nobody else. The first 1:1 iMessage or SMS whose text contains that code makes
 * the sender's number the owner. Texting first is not enough: without a valid
 * code configured, claiming is off.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { InstinctConfig } from "./types.js";

/** Shortest code (letters and digits only) we accept. Front doors should use 16+ random characters. */
export const MIN_CLAIM_CODE_LENGTH = 8;
/** Wrong-code messages one number may send before it can no longer claim. */
export const MAX_CLAIM_ATTEMPTS = 10;
/** Whitespace-separated words of a message that are checked against the code. */
export const MAX_CLAIM_TOKENS = 10;
/** What the model sees when the claiming message was nothing but the code. */
export const CLAIM_WELCOME_TEXT = "[I just texted my one-time sign-up code, so I am your owner now. Say hello.]";

/** Letters and digits only, upper case: "k7p2 qx9m", "K7P2-QX9M" and "k7p2qx9m" are the same code. */
export function normalizeClaimCode(s: string): string {
  return s.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
}

export type ClaimStatus = { enabled: true; code: string } | { enabled: false; reason: string };

/** Whether this config can be claimed right now, and if not, why (for the boot warning). */
export function ownerClaimStatus(config: InstinctConfig, now: Date = new Date()): ClaimStatus {
  const owner = config.owner;
  if (!owner.claimOnFirstContact) return { enabled: false, reason: "claimOnFirstContact is not set" };
  if (owner.phones.length > 0) return { enabled: false, reason: "the owner already has a phone" };
  const code = normalizeClaimCode(owner.claimCode ?? "");
  if (!code) return { enabled: false, reason: "no claim code is configured (INSTINCT_OWNER_CLAIM_CODE)" };
  if (code.length < MIN_CLAIM_CODE_LENGTH) return { enabled: false, reason: `the claim code is shorter than ${MIN_CLAIM_CODE_LENGTH} letters and digits` };
  if (owner.claimExpiresAt !== undefined) {
    const expires = Date.parse(owner.claimExpiresAt);
    if (Number.isNaN(expires)) return { enabled: false, reason: "claimExpiresAt is not a valid time" };
    if (now.getTime() >= expires) return { enabled: false, reason: "the claim code has expired" };
  }
  return { enabled: true, code };
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time equality: both sides are hashed to 32 bytes first, so lengths never leak. */
function sameCode(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Does `text` carry `code` (already normalized)? Either the whole message is the code
 * (spaces allowed), or one of its first MAX_CLAIM_TOKENS words is. On a match, `rest` is
 * the message with the code removed, so the code never reaches the model or the transcript.
 */
export function matchClaimCode(text: string, code: string): { matched: false } | { matched: true; rest: string } {
  if (!code) return { matched: false };
  const parts = text.split(/(\s+)/);
  let matchedAny = sameCode(normalizeClaimCode(text), code);
  if (matchedAny) return { matched: true, rest: "" };
  let words = 0;
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "" || /^\s+$/.test(part)) {
      kept.push(part);
      continue;
    }
    words++;
    // Every checked word is compared; no early exit on a match.
    if (words <= MAX_CLAIM_TOKENS && sameCode(normalizeClaimCode(part), code)) {
      matchedAny = true;
      continue;
    }
    kept.push(part);
  }
  if (!matchedAny) return { matched: false };
  return { matched: true, rest: kept.join("").replace(/[ \t]{2,}/g, " ").trim() };
}
