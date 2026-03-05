import { FastifyPluginAsync } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { NotFoundError } from '../lib/errors.js';

const conversationsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /v1/conversations — List conversations
  fastify.get('/v1/conversations', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const conversationsList = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.accountId, request.accountId))
      .limit(limit)
      .offset(offset)
      .orderBy(desc(schema.conversations.lastMessageAt));

    return { data: conversationsList, limit, offset };
  });

  // GET /v1/conversations/:conversationId — Get conversation details
  fastify.get('/v1/conversations/:conversationId', async (request) => {
    const { conversationId } = request.params as { conversationId: string };

    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.accountId, request.accountId),
        ),
      )
      .limit(1);

    if (!conversation) throw new NotFoundError('Conversation');
    return conversation;
  });

  // GET /v1/conversations/:conversationId/messages — List messages in a conversation
  fastify.get('/v1/conversations/:conversationId/messages', async (request) => {
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);
    const offset = parseInt(query.offset || '0', 10);

    // Verify conversation belongs to account
    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.accountId, request.accountId),
        ),
      )
      .limit(1);

    if (!conversation) throw new NotFoundError('Conversation');

    const messagesList = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .limit(limit)
      .offset(offset)
      .orderBy(desc(schema.messages.createdAt));

    return { data: messagesList, limit, offset };
  });
};

export default conversationsRoutes;
