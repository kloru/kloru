/**
 * Model-facing schemas for the desktop tools.
 *
 * The property set mirrors Maritime's own `computer` tool (desktopd mcp_server.py and the
 * hosted Computers MCP) field for field, so prompts and evals written for one transfer to
 * the other. Coordinates and the action enum are emitted as plain JSON Schema through
 * `Type.Unsafe` because every provider accepts `{type:"array", items, minItems, maxItems}`
 * while some reject TypeBox's tuple encoding.
 */
import { Type, type Static, type TSchema, type TUnsafe } from "typebox";

export const ACTION_ENUM = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "zoom",
  "cursor_position",
] as const;

export type ActionName = (typeof ACTION_ENUM)[number];

export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/** The frame the model sees by default. The physical display is 1280x800. */
export const MODEL_FRAME = { width: 1200, height: 750 } as const;

function coordinate(description: string): TUnsafe<[number, number]> {
  return Type.Unsafe<[number, number]>({
    type: "array",
    items: { type: "integer" },
    minItems: 2,
    maxItems: 2,
    description,
  });
}

export const ComputerActionSchema = Type.Object({
  action: Type.Unsafe<ActionName>({
    type: "string",
    enum: [...ACTION_ENUM],
    description: "The action to perform.",
  }),
  coordinate: Type.Optional(
    coordinate(
      `[x, y] pixel coordinate in the frame of the LAST screenshot (its reported width x height; default ${MODEL_FRAME.width}x${MODEL_FRAME.height})`,
    ),
  ),
  start_coordinate: Type.Optional(coordinate("left_click_drag start [x, y]")),
  text: Type.Optional(
    Type.String({
      description:
        "type: the text to type. key/hold_key: xdotool key name (e.g. Return, ctrl+s). Omit for clicks (an empty string is fine).",
    }),
  ),
  key: Type.Optional(Type.String({ description: "key/hold_key: xdotool key name (alias of text)" })),
  modifier: Type.Optional(
    Type.String({
      description: "clicks/scroll only: key held during the action, e.g. ctrl, shift, ctrl+shift. Omit for a plain click.",
    }),
  ),
  repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  scroll_direction: Type.Optional(
    Type.Unsafe<ScrollDirection>({ type: "string", enum: [...SCROLL_DIRECTIONS] }),
  ),
  scroll_amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  duration: Type.Optional(Type.Number({ description: "wait/hold_key seconds" })),
  region: Type.Optional(
    Type.Unsafe<[number, number, number, number]>({
      type: "array",
      items: { type: "integer" },
      minItems: 4,
      maxItems: 4,
      description: "zoom: [x0, y0, x1, y1] crop in screenshot coordinates, returned upscaled to the full frame",
    }),
  ),
  no_screenshot: Type.Optional(Type.Boolean({ description: "skip the post-action screenshot" })),
});

export type ComputerAction = Static<typeof ComputerActionSchema>;

export const ComputerBatchSchema = Type.Object({
  actions: Type.Array(ComputerActionSchema, { minItems: 1, maxItems: 50 }),
});

export const RequestTakeoverSchema = Type.Object({
  reason: Type.String({ description: 'Shown to the owner, e.g. "Please log in to Gmail".' }),
  timeout: Type.Optional(
    Type.Number({ description: "seconds the owner has to finish, default 600, max 600; only matters with wait" }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Block until the owner clicks Done or Failed (default false). Leave it false in a chat: the call would hold for minutes. Poll takeover_status instead.",
    }),
  ),
});

export const PathSchema = Type.Object({
  path: Type.String({ description: "Absolute path under /data or /home/desk." }),
});

export const WriteFileSchema = Type.Object({
  path: Type.String({ description: "Absolute path under /data or /home/desk. Parent directories are created." }),
  content: Type.String({ description: "File content. UTF-8 text unless encoding is base64." }),
  encoding: Type.Optional(Type.Unsafe<"utf8" | "base64">({ type: "string", enum: ["utf8", "base64"], description: "Default utf8." })),
});

export const EmptySchema = Type.Object({});

const TOOL_NAME = /[^A-Za-z0-9_-]/g;

/** Providers allow at most 64 characters of [A-Za-z0-9_-]. */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(TOOL_NAME, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn an MCP tool's JSON Schema into a TypeBox schema Pi can hand to a provider. Providers
 * require an object schema, and some reject one without `properties`, so both are forced.
 */
export function mcpSchemaToTypeBox(inputSchema: Record<string, unknown> | undefined): TSchema {
  const schema = inputSchema ?? {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Type.Unsafe<Record<string, unknown>>({ ...schema, type: "object", properties });
}

/** True when the schema declares a `computer_id` property (every hosted tool except get_computer). */
export function schemaHasProperty(inputSchema: Record<string, unknown> | undefined, name: string): boolean {
  const properties = inputSchema?.properties;
  return isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, name);
}
