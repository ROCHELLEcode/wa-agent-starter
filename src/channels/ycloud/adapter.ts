import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { requestJson } from '../../integrations/http.js';
import { safeEqual } from '../../security.js';
import type { RequestWithRawBody } from '../../server.js';
import type { ChannelAdapter, ChannelContext, NormalizedMessage, SendOutboundInput } from '../types.js';
import { ycloudEnv } from './env.js';

const WEBHOOK_PATH = '/webhooks/ycloud';

/**
 * Adaptador de YCloud (proveedor de la WhatsApp Business API).
 *
 * Configuración en YCloud: Developers → Webhooks → agregá
 *   https://TU-DOMINIO/webhooks/ycloud   (evento: whatsapp.inbound_message.received)
 * y copiá el "secret" que te dan a YCLOUD_WEBHOOK_SECRET.
 *
 * Docs: https://docs.ycloud.com/ (WhatsApp Messages API + Webhooks).
 */
export const ycloudAdapter: ChannelAdapter = {
  name: 'ycloud',
  mode: 'queue',

  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void {
    app.post(WEBHOOK_PATH, async (request, reply) => {
      if (ycloudEnv.YCLOUD_WEBHOOK_SECRET) {
        const raw = (request as RequestWithRawBody).rawBody ?? Buffer.from('');
        if (!ycloudSignatureValid(raw, request.headers['ycloud-signature'], ycloudEnv.YCLOUD_WEBHOOK_SECRET)) {
          logger.warn('webhook ycloud rechazado: firma inválida');
          return reply.code(401).send({ error: 'firma inválida' });
        }
      }

      const message = parseInbound(request.body);
      if (message) await ctx.enqueue(message);
      // Respondemos 200 rápido: YCloud reintenta si tardamos o si fallamos.
      return reply.code(200).send({ ok: true });
    });

    logger.info({ path: WEBHOOK_PATH }, 'canal ycloud listo');
  },

  async sendOutbound({ externalContactId, text }: SendOutboundInput): Promise<{ messageId?: string }> {
    const res = await requestJson<{ id?: string; whatsappMessage?: { id?: string } }>(
      'https://api.ycloud.com/v2/whatsapp/messages/sendDirectly',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ycloudEnv.YCLOUD_API_KEY}` },
        body: {
          from: ycloudEnv.YCLOUD_FROM_NUMBER,
          to: externalContactId,
          type: 'text',
          text: { body: text },
        },
        context: 'ycloud.send',
      },
    );
    return { messageId: res.whatsappMessage?.id ?? res.id };
  },
};

/**
 * Verifica el header `YCloud-Signature: t={timestamp},s={signature}`.
 * La firma es HMAC-SHA256 sobre `${timestamp}.${rawBody}` con el secret del
 * webhook. Ver: https://docs.ycloud.com/reference/webhook-integration-guide
 */
function ycloudSignatureValid(raw: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.s;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${raw.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return safeEqual(signature, expected);
}

/**
 * YCloud manda el mensaje en `whatsappInboundMessage`. Solo procesamos texto
 * por ahora (ver notas de diseño del README sobre audio/imágenes).
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
