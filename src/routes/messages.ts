import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { deliverWebhook } from '../services/webhook.js';
import { getDefaultCarrier } from '../services/carriers/index.js';
import { config } from '../config.js';
import { getOrCreateConversation, updateConversationLastMessage } from '../services/conversations.js';
import { isOptedOut } from '../services/opt-out.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';

const sendMessageSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  from: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  body: z.string().min(1).max(1600),
  mediaUrls: z.array(z.string().url()).max(10).optional(),
  webhookUrl: z.string().url().optional(),
  scheduledAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const messagesRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /v1/messages — Send a message
  fastify.post('/v1/messages', async (request, reply) => {
    const body = sendMessageSchema.parse(request.body);

    // Verify the 'from' number belongs to this account and has SMS capability
    const [phoneNumber] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.number, body.from),
          eq(schema.phoneNumbers.accountId, request.accountId),
          eq(schema.phoneNumbers.status, 'active'),
        ),
      )
      .limit(1);

    if (!phoneNumber) {
      throw new BadRequestError(`Phone number ${body.from} is not owned by this account or not active`);
    }

    const capabilities = phoneNumber.capabilities as string[];
    if (!capabilities.includes('sms')) {
      throw new BadRequestError(`Phone number ${body.from} does not have SMS capability`);
    }

    // Check opt-out status
    if (await isOptedOut(request.accountId, body.from, body.to)) {
      throw new BadRequestError(`Recipient ${body.to} has opted out of messages from ${body.from}`);
    }

    // Handle scheduled messages
    if (body.scheduledAt) {
      const scheduledTime = new Date(body.scheduledAt);
      if (scheduledTime <= new Date()) {
        throw new BadRequestError('scheduledAt must be in the future');
      }

      const [scheduled] = await db.insert(schema.scheduledMessages).values({
        accountId: request.accountId,
        from: body.from,
        to: body.to,
        body: body.body,
        mediaUrls: body.mediaUrls,
        scheduledAt: scheduledTime,
        webhookUrl: body.webhookUrl || request.account.webhookUrl,
        metadata: body.metadata,
      }).returning();

      reply.status(201);
      return {
        id: scheduled.id,
        status: 'scheduled',
        scheduledAt: scheduled.scheduledAt,
        from: body.from,
        to: body.to,
        createdAt: scheduled.createdAt,
      };
    }

    // Get or create conversation thread
    const { id: conversationId } = await getOrCreateConversation(request.accountId, body.from, body.to);

    // Calculate segments (SMS = 160 chars GSM-7, 70 chars UCS-2)
    const segments = Math.ceil(body.body.length / 160);

    const [message] = await db.insert(schema.messages).values({
      conversationId,
      accountId: request.accountId,
      direction: 'outbound',
      from: body.from,
      to: body.to,
      body: body.body,
      mediaUrls: body.mediaUrls,
      status: 'queued',
      segments,
      webhookUrl: body.webhookUrl || request.account.webhookUrl,
      metadata: body.metadata,
    }).returning();

    // Update conversation thread
    await updateConversationLastMessage(conversationId, message.id);

    // Send via carrier API
    if (config.telnyx.apiKey) {
      const carrier = getDefaultCarrier();
      const internalWebhookUrl = `${config.server.env === 'development' ? 'http://localhost:3000' : ''}/internal/carrier/webhook`;

      const result = await carrier.sendSms({
        from: body.from,
        to: body.to,
        body: body.body,
        mediaUrls: body.mediaUrls,
        webhookUrl: internalWebhookUrl,
      });

      const statusUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (result.success) {
        statusUpdate.status = 'sending';
        statusUpdate.carrierMessageId = result.carrierMessageId;
        statusUpdate.carrierId = 'telnyx';
        statusUpdate.segments = result.segments;
      } else {
        statusUpdate.status = 'failed';
        statusUpdate.errorMessage = result.error;
      }

      await db.update(schema.messages)
        .set(statusUpdate)
        .where(eq(schema.messages.id, message.id));

      // Notify account webhook of send status
      const webhookUrl = body.webhookUrl || request.account.webhookUrl;
      if (webhookUrl) {
        deliverWebhook(
          request.accountId,
          webhookUrl,
          result.success ? 'message.sending' : 'message.failed',
          { messageId: message.id, from: body.from, to: body.to, status: result.success ? 'sending' : 'failed' },
          request.account.webhookSecret,
        ).catch(() => {});
      }

      reply.status(201);
      return {
        id: message.id,
        status: result.success ? 'sending' : 'failed',
        direction: 'outbound',
        from: message.from,
        to: message.to,
        body: message.body,
        segments: result.segments || segments,
        error: result.error,
        createdAt: message.createdAt,
      };
    }

    // No carrier configured — stay in queued state (dev mode)
    reply.status(201);
    return {
      id: message.id,
      status: 'queued',
      direction: 'outbound',
      from: message.from,
      to: message.to,
      body: message.body,
      segments,
      createdAt: message.createdAt,
    };
  });

  // GET /v1/messages/:messageId — Get message details
  fastify.get('/v1/messages/:messageId', async (request) => {
    const { messageId } = request.params as { messageId: string };

    const [message] = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.accountId, request.accountId)))
      .limit(1);

    if (!message) throw new NotFoundError('Message');
    return message;
  });

  // GET /v1/messages — List messages
  fastify.get('/v1/messages', async (request) => {
    const query = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const conditions = [eq(schema.messages.accountId, request.accountId)];
    if (query.status) {
      conditions.push(eq(schema.messages.status, query.status as any));
    }

    const messagesList = await db
      .select()
      .from(schema.messages)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(schema.messages.createdAt);

    return { data: messagesList, limit, offset };
  });
};

export default messagesRoutes;
