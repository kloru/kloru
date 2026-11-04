import type { RegisteredTool } from "@kloru/core";

/** How the server picks a desktop. See docs/ARCHITECTURE.md, "Configuration". */
export type ComputerMode = "auto" | "desktopd" | "maritime" | "none";

/**
 * A source of computer tools. The server asks for the tools once at boot and registers them
 * in the core ToolRegistry; the backend owns the connection for the life of the process.
 */
export interface ComputerBackend {
  kind: "desktopd" | "maritime";
  /** One line for logs and the system prompt, with no secrets. */
  describe(): string;
  tools(): Promise<RegisteredTool[]>;
  close(): Promise<void>;
}

export type Logger = (message: string) => void;
