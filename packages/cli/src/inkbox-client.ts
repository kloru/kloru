/**
 * The slice of @kloru/inkbox the CLI uses, behind a factory so tests
 * can hand in a fake without HTTP. The default builds the real provisioner.
 */
import { InkboxProvisioner } from "@kloru/inkbox";
import type { CliIo } from "./io.js";

export interface ProvisionerLike {
  provisionIdentity(input: { handle: string; displayName: string; description?: string; imessage?: boolean; phone?: boolean; reuseExisting?: boolean }): Promise<{
    identityId: string;
    handle: string;
    email: string;
    phone?: string;
    imessageEnabled: boolean;
    tunnelHost?: string;
  }>;
  mintIdentityKey(identityId: string, label: string): Promise<string>;
  createSigningKey(handle: string): Promise<string>;
  ensureSigningKey(handle: string, opts?: { knownSigningKey?: string; rotate?: boolean }): Promise<string>;
  routerInfo(): Promise<{ number: string; connectCommand: string; smsLink: string; qrPngDataUrl: string }>;
  addContactRule(handle: string, peerHandle: string, direction?: "inbound" | "outbound" | "both"): Promise<void>;
  createInvitation(input: { peerHandles: string[]; recipientEmail?: string; expiresInSeconds?: number }): Promise<{
    id: string;
    invitationUrl?: string;
    invitationToken?: string;
    agentHandoffPrompt?: string;
  }>;
}

export interface ProvisionerOptions {
  apiKey: string;
  baseUrl?: string;
}

export type ProvisionerFactory = (opts: ProvisionerOptions) => ProvisionerLike;

export function makeProvisioner(io: CliIo, env: NodeJS.ProcessEnv, apiKey: string): ProvisionerLike {
  const opts: ProvisionerOptions = { apiKey, baseUrl: env.INKBOX_BASE_URL };
  if (io.createProvisioner) return io.createProvisioner(opts);
  return new InkboxProvisioner({ adminApiKey: opts.apiKey, baseUrl: opts.baseUrl, fetchImpl: io.fetchImpl ?? globalThis.fetch });
}
