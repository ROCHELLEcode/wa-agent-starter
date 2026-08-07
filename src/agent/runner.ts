import type OpenAI from 'openai';
import { env } from '../env.js';
import { logger } from '../logger.js';
import type { Contact, Conversation, ConversationStore, HistoryMessage } from '../memory/store.js';
import type { AgentConfig } from '../config.js';
import { llm } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { sanitizeReply } from './sanitize.js';
import { defaultTools, type Tool, type ToolContext } from './tools/index.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface RunAgentInput {
  store: ConversationStore;
  conversation: Conversation;
  contact: Contact;
  /** Lo último que dijo el usuario. null en un turno proactivo (seguimiento). */
  userText: string | null;
  config: AgentConfig;
  /** Herramientas disponibles. Por defecto, las de tools/index.ts. */
  tools?: Tool[];
  /** Instrucción de sistema extra para este turno (p.ej. un seguimiento). */
  instruction?: string;
}

export interface AgentResult {
  /** Texto a enviar. null si el modelo no produjo respuesta. */
  reply: string | null;
  toolsUsed: string[];
}

/**
 * Corre el agente sobre lo último que dijo el usuario y devuelve la respuesta.
 * Cada paso (mensaje del modelo, tool call, su resultado) se persiste apenas
 * ocurre: si el proceso muere a mitad del loop, la conversación se reconstruye.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const { store, conversation, contact, userText, config } = input;
  const tools = input.tools ?? defaultTools;

  if (userText) {
    await store.appendMessage(conversation.id, { role: 'user', content: userText });
  }

  const history = await store.getHistory(conversation.id, env.AGENT_HISTORY_LIMIT);

  const ctx: ToolContext = {
    contactId: contact.id,
    conversationId: conversation.id,
    contactName: contact.name,
    store,
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ config, contactName: contact.name }) },
    ...pruneOrphanToolCalls(toChat(history)),
    ...(input.instruction ? [{ role: 'system' as const, content: input.instruction }] : []),
  ];

  const toolDefs = tools.map((t) => t.definition);
  const toolMap = new Map(tools.map((t) => [t.definition.function.name, t]));
  const toolsUsed: string[] = [];

  for (let i = 0; i < env.AGENT_MAX_TOOL_ITERATIONS; i++) {
    const completion = await llm.chat.completions.create({
      model: env.LLM_MODEL,
      messages,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      max_tokens: env.LLM_MAX_TOKENS,
      temperature: env.LLM_TEMPERATURE,
    });

    const choice = completion.choices[0];
    if (!choice) {
      logger.error({ completion }, 'el modelo no devolvió ninguna opción');
      return { reply: null, toolsUsed };
    }

    const message = choice.message;
    const toolCalls = message.tool_calls ?? [];

    await store.appendMessage(conversation.id, {
      role: 'assistant',
      content: message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
    });
    messages.push(message as ChatMessage);

    // Sin herramientas pedidas, esto es la respuesta final.
    if (toolCalls.length === 0) {
      const t = message.content?.trim();
      return { reply: t ? sanitizeReply(t) : null, toolsUsed };
    }

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const name = call.function.name;
      toolsUsed.push(name);

      const result = await runTool(toolMap, name, call.function.arguments, ctx);
      const content = JSON.stringify(result);

      await store.appendMessage(conversation.id, { role: 'tool', content, toolCallId: call.id });
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  logger.warn({ conversationId: conversation.id, toolsUsed }, 'el agente agotó las iteraciones de herramientas');
  return { reply: null, toolsUsed };
}

/** Reconstruye el historial guardado al formato que espera la API. */
function toChat(history: HistoryMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      const toolCalls = m.toolCalls as ToolCall[] | null | undefined;
      out.push({
        role: 'assistant',
        content: m.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      } as ChatMessage);
    } else if (m.role === 'tool' && m.toolCallId) {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
    }
  }
  return out;
}

/**
 * Un `assistant` con tool_calls DEBE ir seguido de un `tool` por cada llamada,
 * o la API rechaza todo. Si el historial quedó cortado a mitad de un loop
 * (proceso caído), podamos esa cola antes de mandarla.
 */
function pruneOrphanToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const isAssistantWithTools =
      last.role === 'assistant' && 'tool_calls' in last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
    if (!isAssistantWithTools) break;
    out.pop();
  }
  while (out.length > 0 && out[0]!.role === 'tool') out.shift();
  return out;
}

/** Ejecuta la herramienta y NUNCA lanza: un error vuelve al modelo como dato. */
async function runTool(
  toolMap: Map<string, Tool>,
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = toolMap.get(name);
  if (!tool) {
    logger.error({ name }, 'el modelo pidió una herramienta que no existe');
    return { error: `La herramienta ${name} no existe.` };
  }

  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    logger.error({ err, name, argsJson }, 'argumentos de herramienta con JSON inválido');
    return { error: 'Los argumentos no son JSON válido. Reintentá con el formato correcto.' };
  }

  try {
    return await tool.run(args, ctx);
  } catch (err) {
    logger.error({ err, name, args }, 'falló la ejecución de una herramienta');
    return { error: 'La herramienta falló. No se lo menciones al usuario; seguí la conversación con naturalidad.' };
  }
}
