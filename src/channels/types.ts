import type { FastifyInstance } from 'fastify';
import type { AgentConfig } from '../config.js';
import type { ConversationStore } from '../memory/store.js';

/**
 * La abstracción central del kit. El "cerebro" del agente es siempre el mismo;
 * el ADAPTADOR DE CANAL lo conecta con dónde llegan los mensajes (WhatsApp
 * Cloud API, GHL, Chatwoot, YCloud, tu app web…).
 *
 * Un adaptador hace tres cosas: recibir (parsear el webhook a un mensaje
 * normalizado), enviar (mandar la respuesta), y montar sus rutas HTTP.
 */

/** Un mensaje, ya traducido a la forma común, venga del canal que venga. */
export interface NormalizedMessage {
  /** Id del contacto en el sistema externo (número de WhatsApp, id de GHL…). */
  externalContactId: string;
  externalConversationId?: string | null;
  externalMessageId?: string | null;
  text: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  /** true si lo escribió el usuario; false si es un eco de algo que enviamos. */
  isInbound: boolean;
  metadata?: Record<string, unknown>;
}

/** Lo que el runtime le da al adaptador para procesar mensajes. */
export interface ChannelContext {
  store: ConversationStore;
  config: AgentConfig;
  /** Encola un entrante para procesarlo async (canales por webhook). */
  enqueue(message: NormalizedMessage): Promise<void>;
  /** Procesa un entrante en línea y devuelve la respuesta (canal web). */
  runInline(message: NormalizedMessage): Promise<string | null>;
}

export interface SendOutboundInput {
  externalContactId: string;
  text: string;
  externalConversationId?: string | null;
}

export interface ChannelAdapter {
  readonly name: string;
  /**
   * 'queue' = webhook async (WhatsApp real): valida, parsea, encola, responde
   * 200; el worker responde después vía sendOutbound.
   * 'inline' = request/respuesta (web): corre el agente y devuelve la respuesta
   * en la misma llamada HTTP.
   */
  readonly mode: 'queue' | 'inline';
  /** Monta las rutas HTTP del canal (webhook, UI…). */
  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void | Promise<void>;
  /** Envía la respuesta del agente por el canal. Los inline pueden dejarlo no-op. */
  sendOutbound(input: SendOutboundInput): Promise<{ messageId?: string }>;
}
