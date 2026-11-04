/** `instinct chat "<message>"`: talk to a running agent, locally or through Maritime. */
import { parse, str, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError, fetchOf } from "../io.js";
import { DEFAULT_LOCAL_URL, localChat } from "../local.js";
import { chatWithAgent, maritimeBaseUrl } from "../maritime.js";

export const chatOptions: OptionSpec = {
  url: { type: "string" },
  agent: { type: "string" },
  conversation: { type: "string" },
};

export async function runChat(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("chat", argv, chatOptions);
  const message = positionals.join(" ").trim();
  if (!message) throw new UsageError('chat needs a message: instinct chat "what is on my calendar today"', "chat");
  const agent = str(values, "agent");
  const conversationId = str(values, "conversation");
  const f = fetchOf(ctx.io);

  let result: { response: string | null; error?: string };
  if (agent) {
    const apiKey = ctx.env.MARITIME_API_KEY;
    if (!apiKey) throw new CliError("MARITIME_API_KEY is required for --agent.");
    result = await chatWithAgent({ apiKey, baseUrl: maritimeBaseUrl(ctx.env), fetchImpl: f }, agent, message, conversationId);
  } else {
    result = await localChat(f, str(values, "url") ?? DEFAULT_LOCAL_URL, { message, source: "cli", conversation_id: conversationId }, ctx.env.INSTINCT_CHAT_TOKEN);
  }
  if (result.response === null || result.response === undefined) {
    throw new CliError(`The agent did not answer${result.error ? `: ${result.error}` : "."}`);
  }
  ctx.print(result.response);
  return 0;
}
