export {
  OIP_INTENTS,
  OIP_VERSION,
  encodeOip,
  decodeOip,
  describeOip,
  oipToText,
  type OipIntent,
  type OipMessage,
  type OipTextOptions,
} from "./oip.js";
export { CAPABILITIES, TIERS, ASSIGNABLE_TIERS, isCapability, isTier, parseCapabilities } from "./capabilities.js";
export { resolveA2aPrincipal, normalizeAgentHandle } from "./principal.js";
export { networkGuidance } from "./guidance.js";
export { lookupContact, slugify, phoneKey, contactLine, type ContactLookup, type LookupOptions } from "./lookup.js";
export { networkTools, type NetworkToolDeps, type A2aLike, type ProvisionerLike } from "./tools.js";
