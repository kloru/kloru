export { READ_TOOLS, TOOL_CAPABILITIES, capabilitiesFor, isSupportedTool } from "./capabilities.js";
export {
  ATOMIC_MAIL_REQUEST_TIMEOUT_MS,
  AtomicMailBackend,
  DEFAULT_ATOMIC_MAIL_MCP_URL,
  type AtomicMailBackendOptions,
  type Logger,
} from "./backend.js";
export { atomicMailGuidance } from "./guidance.js";
export {
  INBOX_LABEL,
  TOOL_NAME_PREFIX,
  describeCall,
  explainError,
  metaFor,
  parametersFor,
  toolNameFor,
  wrapMcpTool,
  wrapMcpTools,
  type McpToolSource,
} from "./wrap.js";
