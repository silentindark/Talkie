import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getDefaultCarrier } from '../services/carriers/index.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';
import { config } from '../config.js';

const searchNumbersSchema = z.object({
  country: z.string().length(2).default('US'),
  areaCode: z.string().optional(),
  contains: z.string().optional(),
  locality: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
  capabilities: z.array(z.enum(['voice', 'sms', 'mms'])).optional(),
});

const provisionNumberSchema = z.object({
  number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  friendlyName: z.string().max(255).optional(),
});

const updateNumberSchema = z.object({
  friendlyName: z.string().max(255).optional(),
  voiceWebhookUrl: z.string().url().nullable().optional(),
  smsWebhookUrl: z.string().url().nullable().optional(),
});

const phoneNumbersRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /v1/phone-numbers — List account's phone numbers
  fastify.get('/v1/phone-numbers', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const numbers = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.accountId, request.accountId),
          eq(schema.phoneNumbers.status, 'active'),
        ),
      )
      .limit(limit)
      .offset(offset)
      .orderBy(schema.phoneNumbers.createdAt);

    return { data: numbers, limit, offset };
  });

  // GET /v1/phone-numbers/:numberId — Get phone number details
  fastify.get('/v1/phone-numbers/:numberId', async (request) => {
    const { numberId } = request.params as { numberId: string };

    const [number] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, numberId),
          eq(schema.phoneNumbers.accountId, request.accountId),
        ),
      )
      .limit(1);

    if (!number) throw new NotFoundError('Phone number');
    return number;
  });

  // PATCH /v1/phone-numbers/:numberId — Update phone number configuration
  fastify.patch('/v1/phone-numbers/:numberId', async (request) => {
    const { numberId } = request.params as { numberId: string };
    const body = updateNumberSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, numberId),
          eq(schema.phoneNumbers.accountId, request.accountId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundError('Phone number');

    const [updated] = await db
      .update(schema.phoneNumbers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.phoneNumbers.id, numberId))
      .returning();

    return updated;
  });

  // DELETE /v1/phone-numbers/:numberId — Release a phone number
  fastify.delete('/v1/phone-numbers/:numberId', async (request) => {
    const { numberId } = request.params as { numberId: string };

    const [existing] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, numberId),
          eq(schema.phoneNumbers.accountId, request.accountId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundError('Phone number');

    // Release via carrier if we have a carrier number ID
    if (existing.carrierNumberId) {
      const carrier = getDefaultCarrier();
      const result = await carrier.releaseNumber(existing.carrierNumberId);
      if (!result.success) {
        throw new BadRequestError(`Failed to release number from carrier: ${result.error}`);
      }
    }

    await db
      .update(schema.phoneNumbers)
      .set({ status: 'released', accountId: null, updatedAt: new Date() })
      .where(eq(schema.phoneNumbers.id, numberId));

    return { id: numberId, status: 'released' };
  });

  // POST /v1/phone-numbers/search — Search available numbers from carrier
  fastify.post('/v1/phone-numbers/search', async (request) => {
    const body = searchNumbersSchema.parse(request.body);
    const carrier = getDefaultCarrier();

    if (!config.telnyx.apiKey) {
      throw new BadRequestError('Carrier API not configured. Set TELNYX_API_KEY in environment.');
    }

    const numbers = await carrier.searchNumbers(body);
    return { data: numbers };
  });

  // POST /v1/phone-numbers/provision — Provision a number via carrier
  fastify.post('/v1/phone-numbers/provision', async (request, reply) => {
    const body = provisionNumberSchema.parse(request.body);
    const carrier = getDefaultCarrier();

    // Check if number already exists in our system
    const [existing] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.number, body.number))
      .limit(1);

    if (existing && existing.status === 'active') {
      throw new BadRequestError(`Number ${body.number} is already provisioned`);
    }

    // Provision via carrier API if configured, otherwise local-only (dev mode)
    let carrierId = 'local';
    let carrierNumberId = '';

    if (config.telnyx.apiKey) {
      const webhookUrl = `${config.server.env === 'development' ? 'http://localhost:3000' : ''}/internal/carrier/webhook`;
      const result = await carrier.provisionNumber(body.number, webhookUrl);
      if (!result.success) {
        throw new BadRequestError(`Failed to provision number: ${result.error}`);
      }
      carrierId = result.carrierId;
      carrierNumberId = result.carrierNumberId;
    }

    const [phoneNumber] = await db.insert(schema.phoneNumbers).values({
      accountId: request.accountId,
      number: body.number,
      friendlyName: body.friendlyName,
      status: 'active',
      capabilities: ['voice', 'sms'],
      carrierId,
      carrierNumberId,
    }).returning();

    reply.status(201);
    return phoneNumber;
  });
};

export default phoneNumbersRoutes;
