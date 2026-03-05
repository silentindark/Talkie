import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import { freeswitchService } from './services/freeswitch.js';
import { audioStreamManager } from './services/audio-stream.js';
import { db, schema } from './db/index.js';
import { eq } from 'drizzle-orm';
import { AppError } from './lib/errors.js';
import { ZodError } from 'zod';

// Routes
import accountsRoutes from './routes/accounts.js';
import callsRoutes from './routes/calls.js';
import messagesRoutes from './routes/messages.js';
import phoneNumbersRoutes from './routes/phone-numbers.js';
import streamRoutes from './routes/stream.js';
import internalRoutes from './routes/internal.js';
import conversationsRoutes from './routes/conversations.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { startWebhookWorker, stopWebhookWorker } from './services/webhook-worker.js';

async function main() {
  const fastify = Fastify({
    logger: {
      level: config.server.logLevel,
      transport: config.server.env === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' } }
        : undefined,
    },
  });

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.errors },
      });
    }
    fastify.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  // Plugins
  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyWebsocket);
  await fastify.register(authPlugin);

  // Health check (no auth)
  fastify.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    freeswitch: freeswitchService.isConnected,
    activeStreams: audioStreamManager.getActiveSessionCount(),
    uptime: process.uptime(),
  }));

  // Register routes
  await fastify.register(accountsRoutes);
  await fastify.register(callsRoutes);
  await fastify.register(messagesRoutes);
  await fastify.register(phoneNumbersRoutes);
  await fastify.register(streamRoutes);
  await fastify.register(internalRoutes);
  await fastify.register(conversationsRoutes);

  // Connect to FreeSWITCH (non-blocking)
  freeswitchService.connect().catch(() => {
    fastify.log.warn('FreeSWITCH not available at startup — will retry in background');
  });

  // Start background workers
  startScheduler();
  startWebhookWorker();

  // Handle FreeSWITCH call events
  freeswitchService.on('call.answered', async (data) => {
    const uuid = data['Unique-ID'];
    if (!uuid) return;

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.freeswitchUuid, uuid))
      .limit(1);

    if (call) {
      await db
        .update(schema.calls)
        .set({ status: 'in_progress', answeredAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.calls.id, call.id));
    }
  });

  // Start server
  try {
    await fastify.listen({ port: config.server.port, host: config.server.host });
    console.log(`
  ╔══════════════════════════════════════════╗
  ║                                          ║
  ║   Talkie API Server v0.1.0               ║
  ║   Listening on ${config.server.host}:${config.server.port}            ║
  ║                                          ║
  ║   Endpoints:                             ║
  ║   POST   /v1/accounts                    ║
  ║   GET    /v1/account                     ║
  ║   POST   /v1/calls                       ║
  ║   GET    /v1/calls/:id                   ║
  ║   POST   /v1/calls/:id/actions           ║
  ║   WS     /v1/calls/:id/stream            ║
  ║   POST   /v1/messages                    ║
  ║   GET    /v1/messages/:id                ║
  ║   GET    /v1/phone-numbers               ║
  ║   POST   /v1/phone-numbers/provision     ║
  ║   GET    /v1/conversations                ║
  ║   GET    /v1/conversations/:id/messages  ║
  ║   GET    /health                         ║
  ║                                          ║
  ╚══════════════════════════════════════════╝
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    stopScheduler();
    stopWebhookWorker();
    freeswitchService.disconnect();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
