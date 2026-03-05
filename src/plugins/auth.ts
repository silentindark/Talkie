import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { authenticateApiKey } from '../lib/auth.js';
import { UnauthorizedError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string;
    account: { id: string; name: string; email: string; webhookUrl: string | null; webhookSecret: string | null };
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('accountId', '');
  fastify.decorateRequest('account', null as any);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check
    if (request.url === '/health') return;
    // Skip auth for FreeSWITCH webhooks (authenticated by IP/secret)
    if (request.url.startsWith('/internal/')) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError();
    }

    const key = authHeader.slice(7);
    const result = await authenticateApiKey(key);
    if (!result) {
      throw new UnauthorizedError();
    }

    request.accountId = result.account.id;
    request.account = {
      id: result.account.id,
      name: result.account.name,
      email: result.account.email,
      webhookUrl: result.account.webhookUrl,
      webhookSecret: result.account.webhookSecret,
    };
  });
};

export default fp(authPlugin, { name: 'auth' });
