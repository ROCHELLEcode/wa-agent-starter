import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import type { ChannelAdapter, ChannelContext, NormalizedMessage, SendOutboundInput } from '../types.js';

const WEBHOOK_PATH = '/webhooks/ycloud';

/**
 * ┌───────────────────────────────────────────────────────────┐
 * │  STUB — YCloud. Esqueleto para que lo completes.           │
 * └───────────────────────────────────────────────────────────┘
 *
 * YCloud es un proveedor de la WhatsApp Business API. Para terminarlo:
 *
 * 1. En YCloud: Developers → Webhooks → agregá
 *      https://TU-DOMINIO/webhooks/ycloud   (evento: whatsapp.inbound_message.received)
 * 2. Env vars (validalas en un env.ts): YCLOUD_API_KEY
 * 3. Completá parseInbound (abajo) y sendOutbound (más abajo).
 *
 * Docs: https://docs.ycloud.com/ (WhatsApp Messages API + Webhooks).
 */
export const ycloudAdapter: ChannelAdapter = {
  name: 'ycloud',
  mode: 'queue',

  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void {
    logger.warn('canal ycloud: STUB. Completá parseInbound/sendOutbound en src/channels/ycloud/adapter.ts');
    app.post(WEBHOOK_PATH, async (request, reply) => {
      const message = parseInbound(request.body);
      if (message) await ctx.enqueue(message);
      return reply.code(200).send({ ok: true });
    });
  },

  async sendOutbound(_input: SendOutboundInput): Promise<{ messageId?: string }> {
    // TODO: POST https://api.ycloud.com/v2/whatsapp/messages
    //   headers: { 'X-API-Key': YCLOUD_API_KEY }
    //   body: { from: <tu número>, to: input.externalContactId, type: 'text', text: { body: input.text } }
    throw new Error('ycloud.sendOutbound sin implementar (ver comentarios del archivo)');
  },
};

/**
 * YCloud manda el mensaje en `whatsappInboundMessage`. El texto en
 * `text.body`, el remitente en `from`. Ajustá a la forma real del webhook.
 */
function parseInbound(payload: unknown): NormalizedMessage | null {
  const p = payload as {
    type?: string;
    whatsappInboundMessage?: {
      id?: string;
      from?: string;
      type?: string;
      text?: { body?: string };
      customerProfile?: { name?: string };
    };
  };
  const m = p?.whatsappInboundMessage;
  if (!m?.from) return null;

  const text = m.type === 'text' ? (m.text?.body ?? '').trim() : '';
  if (!text) return null;

  return {
    externalContactId: m.from,
    externalMessageId: m.id ?? null,
    text,
    phone: m.from,
    name: m.customerProfile?.name ?? null,
    isInbound: true,
  };
}
