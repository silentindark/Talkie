import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateApiKey } from '../lib/auth.js';

const createAccountSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  webhookUrl: z.string().url().optional(),
});

const accountsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /v1/accounts — Create a new account (no auth required for bootstrapping)
  fastify.post('/v1/accounts', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    const body = createAccountSchema.parse(request.body);
    const webhookSecret = randomBytes(32).toString('hex');

    const [account] = await db.insert(schema.accounts).values({
      name: body.name,
      email: body.email,
      webhookUrl: body.webhookUrl,
      webhookSecret,
    }).returning();

    // Generate an initial API key
    const { key, prefix, hash } = generateApiKey();

    await db.insert(schema.apiKeys).values({
      accountId: account.id,
      keyHash: hash,
      keyPrefix: prefix,
      label: 'Default',
    });

    reply.status(201);
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      webhookUrl: account.webhookUrl,
      webhookSecret,
      apiKey: key, // Only returned once at creation
      createdAt: account.createdAt,
    };
  });

  // GET /v1/account — Get current account
  fastify.get('/v1/account', async (request) => {
    return request.account;
  });

  // POST /v1/account/api-keys — Generate new API key
  fastify.post('/v1/account/api-keys', async (request, reply) => {
    const body = request.body as { label?: string };
    const { key, prefix, hash } = generateApiKey();

    const [apiKey] = await db.insert(schema.apiKeys).values({
      accountId: request.accountId,
      keyHash: hash,
      keyPrefix: prefix,
      label: body?.label,
    }).returning();

    reply.status(201);
    return {
      id: apiKey.id,
      key, // Only returned once
      prefix,
      label: apiKey.label,
      createdAt: apiKey.createdAt,
    };
  });

  // GET /v1/account/api-keys — List API keys (without full key)
  fastify.get('/v1/account/api-keys', async (request) => {
    const keys = await db
      .select({
        id: schema.apiKeys.id,
        prefix: schema.apiKeys.keyPrefix,
        label: schema.apiKeys.label,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.accountId, request.accountId));

    return { data: keys };
  });

  // DELETE /v1/account/api-keys/:keyId — Revoke an API key
  fastify.delete('/v1/account/api-keys/:keyId', async (request) => {
    const { keyId } = request.params as { keyId: string };

    const result = await db
      .delete(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId))
      .returning();

    if (result.length === 0) {
      return { error: 'API key not found' };
    }

    return { id: keyId, status: 'revoked' };
  });
};

export default accountsRoutes;
