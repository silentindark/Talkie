import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { freeswitchService } from '../services/freeswitch.js';
import { emitCallEvent } from '../services/webhook.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';

const createCallSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  from: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  webhookUrl: z.string().url().optional(),
  agentId: z.string().optional(),
  agentConfig: z.object({
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    voice: z.string().optional(),
    sttProvider: z.string().optional(),
    ttsProvider: z.string().optional(),
  }).optional(),
  record: z.boolean().default(false),
  maxDurationSeconds: z.number().int().min(1).max(14400).default(3600),
  metadata: z.record(z.unknown()).optional(),
});

const callActionSchema = z.object({
  action: z.enum([
    'hangup', 'transfer', 'hold', 'unhold', 'mute', 'unmute',
    'send_dtmf', 'start_stream', 'stop_stream', 'playback',
    'start_recording', 'stop_recording', 'conference',
  ]),
  destination: z.string().optional(),
  digits: z.string().optional(),
  streamUrl: z.string().optional(),
  audioUrl: z.string().optional(),
  conferenceName: z.string().optional(),
});

const callsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /v1/calls — Initiate outbound call
  fastify.post('/v1/calls', async (request, reply) => {
    const body = createCallSchema.parse(request.body);
    const callId = uuid();

    // Verify the 'from' number belongs to this account
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

    // Insert call record
    const [call] = await db.insert(schema.calls).values({
      id: callId,
      accountId: request.accountId,
      direction: 'outbound',
      from: body.from,
      to: body.to,
      status: 'queued',
      agentId: body.agentId,
      agentConfig: body.agentConfig,
      webhookUrl: body.webhookUrl || request.account.webhookUrl,
      metadata: body.metadata,
    }).returning();

    // Initiate call via FreeSWITCH
    try {
      await freeswitchService.originate({
        to: body.to,
        from: body.from,
        gateway: 'telnyx',
        callUuid: callId,
      });

      await db.update(schema.calls)
        .set({ status: 'initiating', updatedAt: new Date() })
        .where(eq(schema.calls.id, callId));

      await emitCallEvent(
        request.accountId,
        callId,
        'call.initiating',
        { to: body.to, from: body.from, direction: 'outbound' },
        call.webhookUrl,
        request.account.webhookSecret,
      );
    } catch (err) {
      await db.update(schema.calls)
        .set({ status: 'failed', endedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.calls.id, callId));

      await emitCallEvent(
        request.accountId,
        callId,
        'call.failed',
        { error: err instanceof Error ? err.message : 'Unknown error' },
        call.webhookUrl,
        request.account.webhookSecret,
      );
    }

    reply.status(201);
    return {
      id: callId,
      status: 'initiating',
      direction: 'outbound',
      from: body.from,
      to: body.to,
      agentId: body.agentId,
      createdAt: call.createdAt,
    };
  });

  // GET /v1/calls/:callId — Get call details
  fastify.get('/v1/calls/:callId', async (request) => {
    const { callId } = request.params as { callId: string };

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.accountId, request.accountId)))
      .limit(1);

    if (!call) throw new NotFoundError('Call');

    return call;
  });

  // GET /v1/calls — List calls
  fastify.get('/v1/calls', async (request) => {
    const query = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const conditions = [eq(schema.calls.accountId, request.accountId)];
    if (query.status) {
      conditions.push(eq(schema.calls.status, query.status as any));
    }

    const callsList = await db
      .select()
      .from(schema.calls)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(schema.calls.createdAt);

    return { data: callsList, limit, offset };
  });

  // POST /v1/calls/:callId/actions — Control an in-progress call
  fastify.post('/v1/calls/:callId/actions', async (request) => {
    const { callId } = request.params as { callId: string };
    const body = callActionSchema.parse(request.body);

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.accountId, request.accountId)))
      .limit(1);

    if (!call) throw new NotFoundError('Call');
    if (!['ringing', 'in_progress'].includes(call.status)) {
      throw new BadRequestError(`Cannot perform action on call with status: ${call.status}`);
    }

    switch (body.action) {
      case 'hangup':
        await freeswitchService.hangup(callId);
        await db.update(schema.calls)
          .set({ status: 'completed', endedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.calls.id, callId));
        break;

      case 'transfer':
        if (!body.destination) throw new BadRequestError('destination required for transfer');
        await freeswitchService.transfer(callId, body.destination);
        break;

      case 'send_dtmf':
        if (!body.digits) throw new BadRequestError('digits required for send_dtmf');
        await freeswitchService.sendDtmf(callId, body.digits);
        break;

      case 'start_stream':
        if (!body.streamUrl) throw new BadRequestError('streamUrl required for start_stream');
        await freeswitchService.startAudioStream(callId, body.streamUrl);
        break;

      case 'stop_stream':
        await freeswitchService.stopAudioStream(callId);
        break;

      case 'hold':
        await freeswitchService.hold(callId);
        break;

      case 'unhold':
        await freeswitchService.unhold(callId);
        break;

      case 'mute':
        await freeswitchService.mute(callId);
        break;

      case 'unmute':
        await freeswitchService.unmute(callId);
        break;

      case 'playback':
        if (!body.audioUrl) throw new BadRequestError('audioUrl required for playback');
        await freeswitchService.playback(callId, body.audioUrl);
        break;

      case 'start_recording': {
        const recordingPath = `/tmp/recordings/${callId}.wav`;
        await freeswitchService.startRecording(callId, recordingPath);
        await db.update(schema.calls)
          .set({ recordingUrl: recordingPath, updatedAt: new Date() })
          .where(eq(schema.calls.id, callId));
        break;
      }

      case 'stop_recording': {
        const existingPath = call.recordingUrl || `/tmp/recordings/${callId}.wav`;
        await freeswitchService.stopRecording(callId, existingPath);
        break;
      }

      case 'conference':
        if (!body.conferenceName) throw new BadRequestError('conferenceName required for conference');
        await freeswitchService.conference(callId, body.conferenceName);
        break;

      default:
        throw new BadRequestError(`Unknown action: ${body.action}`);
    }

    await emitCallEvent(
      request.accountId,
      callId,
      `call.action.${body.action}`,
      { ...body },
      call.webhookUrl,
      request.account.webhookSecret,
    );

    return { callId, action: body.action, status: 'ok' };
  });

  // GET /v1/calls/:callId/events — Get call events
  fastify.get('/v1/calls/:callId/events', async (request) => {
    const { callId } = request.params as { callId: string };

    // Verify call belongs to account
    const [call] = await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.accountId, request.accountId)))
      .limit(1);

    if (!call) throw new NotFoundError('Call');

    const events = await db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callId))
      .orderBy(schema.callEvents.createdAt);

    return { data: events };
  });
};

export default callsRoutes;
