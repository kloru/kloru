/**
 * Which address the owner's surface listens on. Loopback unless the environment
 * says this process is a container whose port is published on purpose.
 */
export const LOOPBACK = "127.0.0.1";
export const ANY = "0.0.0.0";

/** INSTINCT_BIND wins. Otherwise 0.0.0.0 only when PORT or a MARITIME_* variable is present. */
export function bindHostFor(env: NodeJS.ProcessEnv): string {
  const explicit = env.INSTINCT_BIND?.trim();
  if (explicit) return explicit;
  const container = Boolean(env.PORT?.trim() || env.MARITIME_AGENT_ID || env.MARITIME_BACKEND_URL || env.MARITIME_DESKTOP);
  return container ? ANY : LOOPBACK;
}
