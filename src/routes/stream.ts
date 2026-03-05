import { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { audioStreamManager } from '../services/audio-stream.js';
import { freeswitchService } from '../services/freeswitch.js';
import { emitCallEvent, deliverWebhook } from '../services/webhook.js';
import { authenticateApiKey } from '../lib/auth.js';

const streamRoutes: FastifyPluginAsync = async (fastify) => {
  // WebSocket: /v1/calls/:callId/stream — AI agent connects here for real-time audio
  fastify.get('/v1/calls/:callId/stream', { websocket: true }, async (socket, request) => {
    const { callId } = request.params as { callId: string };

    // Authenticate via query param or header
    const url = new URL(request.url, `http://${request.headers.host}`);
    const apiKey = url.searchParams.get('token') || request.headers['x-api-key'] as string;

    if (!apiKey) {
      socket.send(JSON.stringify({ error: 'Missing authentication token' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    const auth = await authenticateApiKey(apiKey);
    if (!auth) {
      socket.send(JSON.stringify({ error: 'Invalid authentication token' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    // Verify call exists and belongs to account
    const [call] = await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.accountId, auth.account.id)))
      .limit(1);

    if (!call) {
      socket.send(JSON.stringify({ error: 'Call not found' }));
      socket.close(4004, 'Not Found');
      return;
    }

    // Check if a stream session already exists
    if (audioStreamManager.getSession(callId)) {
      socket.send(JSON.stringify({ error: 'Stream already active for this call' }));
      socket.close(4009, 'Conflict');
      return;
    }

    // Create audio stream session with call context
    audioStreamManager.createSession({
      callId,
      accountId: auth.account.id,
      agentWs: socket,
      callFrom: call.from,
      callTo: call.to,
      callDirection: call.direction,
    });

    fastify.log.info(`[Stream] Agent connected to call ${callId} (account: ${auth.account.id})`);
  });

  // WebSocket: /internal/stream/:callId — FreeSWITCH mod_audio_stream connects here
  fastify.get('/internal/stream/:callId', { websocket: true }, async (socket, request) => {
    const { callId } = request.params as { callId: string };

    audioStreamManager.attachFreeSWITCHSocket(callId, socket);

    fastify.log.info(`[Stream] FreeSWITCH connected for call ${callId}`);
  });

  // GET /v1/calls/:callId/stream/metrics — Get live stream metrics
  fastify.get('/v1/calls/:callId/stream/metrics', async (request) => {
    const { callId } = request.params as { callId: string };

    // Verify call belongs to account
    const [call] = await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.accountId, request.accountId)))
      .limit(1);

    if (!call) {
      return { error: 'Call not found' };
    }

    const metrics = audioStreamManager.getSessionMetrics(callId);
    if (!metrics) {
      return { error: 'No active stream for this call' };
    }

    return metrics;
  });

  // --- Agent command handler ---
  // When the AI agent sends commands via WebSocket, route them to FreeSWITCH
  audioStreamManager.on('agent.command', async ({ callId, command }) => {
    try {
      switch (command.action) {
        case 'hangup':
          await freeswitchService.hangup(callId, command.cause || 'NORMAL_CLEARING');
          break;
        case 'transfer':
          await freeswitchService.transfer(callId, command.destination);
          break;
        case 'send_dtmf':
          await freeswitchService.sendDtmf(callId, command.digits);
          break;
        case 'stop_playback':
          await freeswitchService.playback(callId, 'silence_stream://0');
          break;
      }
    } catch (err) {
      fastify.log.error(`[Stream] Failed to execute agent command for call ${callId}: ${err}`);
    }
  });

  // --- Transcript relay ---
  // When the agent sends transcript events, forward them as webhooks + store as call events
  audioStreamManager.on('transcript', async ({ callId, accountId, role, text, final }) => {
    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.id, callId))
      .limit(1);

    if (!call) return;

    // Store as call event
    await emitCallEvent(
      accountId,
      callId,
      final ? 'call.transcript.final' : 'call.transcript.partial',
      { role, text, final },
      call.webhookUrl,
    );
  });

  // --- Recording complete handler ---
  audioStreamManager.on('recording.complete', async ({ callId, accountId, audioData, sampleRate }) => {
    // In production: upload to S3/GCS and store the URL
    // For now, emit an event with the recording size
    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.id, callId))
      .limit(1);

    if (!call) return;

    const durationSeconds = audioData.length / (sampleRate * 2); // 2 bytes per sample for L16

    await emitCallEvent(
      accountId,
      callId,
      'call.recording.complete',
      { durationSeconds, sizeBytes: audioData.length, sampleRate },
      call.webhookUrl,
    );

    fastify.log.info(`[Stream] Recording complete for call ${callId}: ${durationSeconds.toFixed(1)}s, ${audioData.length} bytes`);
  });

  // --- Session ended metrics ---
  audioStreamManager.on('session.ended', async (metrics) => {
    fastify.log.info(`[Stream] Session ended for call ${metrics.callId}: ${metrics.durationMs}ms, ${metrics.audioPacketsReceived} packets in, ${metrics.audioPacketsSent} packets out`);
  });
};

export default streamRoutes;
