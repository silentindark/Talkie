import { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { emitCallEvent, deliverWebhook } from '../services/webhook.js';
import { audioStreamManager } from '../services/audio-stream.js';
import { getDefaultCarrier } from '../services/carriers/index.js';
import { getOrCreateConversation, updateConversationLastMessage } from '../services/conversations.js';
import { isOptOutKeyword, isOptInKeyword, recordOptOut, recordOptIn, getOptOutAutoReply, getOptInAutoReply } from '../services/opt-out.js';

// Internal routes called by FreeSWITCH / Kamailio — not exposed via public API
const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /internal/calls/webhook — FreeSWITCH call event webhook
  fastify.post('/internal/calls/webhook', async (request) => {
    const event = request.body as {
      event: string;
      callId: string;
      sipCallId?: string;
      hangupCause?: string;
      duration?: number;
      callerNumber?: string;
      destinationNumber?: string;
    };

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.id, event.callId))
      .limit(1);

    if (!call) return { status: 'ignored', reason: 'call not found' };

    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    switch (event.event) {
      case 'CHANNEL_ANSWER':
        updates.status = 'in_progress';
        updates.answeredAt = now;
        updates.sipCallId = event.sipCallId;
        break;

      case 'CHANNEL_HANGUP_COMPLETE':
        updates.status = event.hangupCause === 'NORMAL_CLEARING' ? 'completed' : 'failed';
        updates.endedAt = now;
        if (event.duration) updates.durationSeconds = event.duration;
        break;

      case 'CHANNEL_PROGRESS':
        updates.status = 'ringing';
        break;

      case 'CHANNEL_BRIDGE':
        updates.status = 'in_progress';
        break;
    }

    await db.update(schema.calls).set(updates).where(eq(schema.calls.id, event.callId));

    const webhookUrl = call.webhookUrl;
    const [account] = call.accountId
      ? await db.select().from(schema.accounts).where(eq(schema.accounts.id, call.accountId)).limit(1)
      : [null];

    if (webhookUrl) {
      await emitCallEvent(
        call.accountId,
        call.id,
        `call.${event.event.toLowerCase()}`,
        event as Record<string, unknown>,
        webhookUrl,
        account?.webhookSecret,
      );
    }

    return { status: 'ok' };
  });

  // POST /internal/calls/inbound — Handle inbound call from Kamailio/FreeSWITCH
  fastify.post('/internal/calls/inbound', async (request, reply) => {
    const body = request.body as {
      from: string;
      to: string;
      sipCallId: string;
      freeswitchUuid: string;
    };

    // Look up the destination number to find the account and webhook
    const [phoneNumber] = await db
      .select()
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.number, body.to))
      .limit(1);

    if (!phoneNumber || !phoneNumber.accountId) {
      reply.status(404);
      return { error: 'Number not provisioned' };
    }

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, phoneNumber.accountId))
      .limit(1);

    if (!account) {
      reply.status(404);
      return { error: 'Account not found' };
    }

    // Create the inbound call record
    const [call] = await db.insert(schema.calls).values({
      accountId: account.id,
      direction: 'inbound',
      from: body.from,
      to: body.to,
      status: 'ringing',
      sipCallId: body.sipCallId,
      freeswitchUuid: body.freeswitchUuid,
      webhookUrl: phoneNumber.voiceWebhookUrl || account.webhookUrl,
    }).returning();

    // Notify account via webhook and get instructions
    const webhookUrl = phoneNumber.voiceWebhookUrl || account.webhookUrl;

    if (webhookUrl) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'call.incoming',
            data: {
              callId: call.id,
              from: body.from,
              to: body.to,
              direction: 'inbound',
            },
          }),
        });

        const instructions = await response.json() as { actions?: Array<Record<string, unknown>> };
        return { callId: call.id, actions: instructions.actions || [] };
      } catch (err) {
        console.error('[Internal] Failed to fetch inbound call instructions:', err);
      }
    }

    // Default: park the call (agent can connect later via API)
    return { callId: call.id, actions: [{ verb: 'park' }] };
  });

  // POST /internal/carrier/webhook — Carrier (Telnyx/Bandwidth) inbound events
  fastify.post('/internal/carrier/webhook', async (request, reply) => {
    const carrier = getDefaultCarrier();
    const body = request.body;

    // Try parsing as inbound SMS
    const inboundSms = carrier.parseInboundSms(body);
    if (inboundSms) {
      // Find the destination number to route to the right account
      const [phoneNumber] = await db
        .select()
        .from(schema.phoneNumbers)
        .where(eq(schema.phoneNumbers.number, inboundSms.to))
        .limit(1);

      if (!phoneNumber || !phoneNumber.accountId) {
        return { status: 'ignored', reason: 'number not provisioned' };
      }

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, phoneNumber.accountId))
        .limit(1);

      if (!account) {
        return { status: 'ignored', reason: 'account not found' };
      }

      // Handle opt-out/opt-in keywords
      const messageText = (inboundSms.body || '').trim();
      if (isOptOutKeyword(messageText)) {
        await recordOptOut(account.id, inboundSms.to, inboundSms.from);
        // Auto-reply with opt-out confirmation
        try {
          await carrier.sendSms({ from: inboundSms.to, to: inboundSms.from, body: getOptOutAutoReply() });
        } catch {}
        return { status: 'ok', action: 'opt_out' };
      }
      if (isOptInKeyword(messageText)) {
        await recordOptIn(account.id, inboundSms.to, inboundSms.from);
        try {
          await carrier.sendSms({ from: inboundSms.to, to: inboundSms.from, body: getOptInAutoReply() });
        } catch {}
        return { status: 'ok', action: 'opt_in' };
      }

      // Get or create conversation thread
      const { id: conversationId } = await getOrCreateConversation(account.id, inboundSms.from, inboundSms.to);

      // Store inbound message
      const [message] = await db.insert(schema.messages).values({
        accountId: account.id,
        conversationId,
        direction: 'inbound',
        from: inboundSms.from,
        to: inboundSms.to,
        body: inboundSms.body,
        mediaUrls: inboundSms.mediaUrls?.length ? inboundSms.mediaUrls : undefined,
        status: 'received',
        carrierMessageId: inboundSms.carrierMessageId,
        carrierId: carrier.name,
        webhookUrl: phoneNumber.smsWebhookUrl || account.webhookUrl,
      }).returning();

      // Update conversation
      await updateConversationLastMessage(conversationId, message.id);

      // Notify account via webhook
      const webhookUrl = phoneNumber.smsWebhookUrl || account.webhookUrl;
      if (webhookUrl) {
        deliverWebhook(
          account.id,
          webhookUrl,
          'message.received',
          {
            messageId: message.id,
            from: inboundSms.from,
            to: inboundSms.to,
            body: inboundSms.body,
            mediaUrls: inboundSms.mediaUrls,
            direction: 'inbound',
          },
          account.webhookSecret,
        ).catch(() => {});
      }

      return { status: 'ok', messageId: message.id };
    }

    // Try parsing as message status update (delivery receipt)
    const event = body as any;
    if (event?.data?.event_type?.startsWith('message.')) {
      const payload = event.data.payload;
      const carrierMessageId = event.data.id || payload?.id;

      if (carrierMessageId) {
        const statusMap: Record<string, string> = {
          'message.sent': 'sent',
          'message.delivered': 'delivered',
          'message.failed': 'failed',
        };
        const newStatus = statusMap[event.data.event_type];

        if (newStatus) {
          const [updated] = await db
            .update(schema.messages)
            .set({
              status: newStatus as any,
              updatedAt: new Date(),
              ...(newStatus === 'failed' ? {
                errorCode: payload?.errors?.[0]?.code,
                errorMessage: payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title,
              } : {}),
            })
            .where(eq(schema.messages.carrierMessageId, carrierMessageId))
            .returning();

          if (updated) {
            const [account] = await db
              .select()
              .from(schema.accounts)
              .where(eq(schema.accounts.id, updated.accountId))
              .limit(1);

            const webhookUrl = updated.webhookUrl;
            if (webhookUrl && account) {
              deliverWebhook(
                account.id,
                webhookUrl,
                `message.${newStatus}`,
                { messageId: updated.id, status: newStatus, from: updated.from, to: updated.to },
                account.webhookSecret,
              ).catch(() => {});
            }
          }
        }
      }

      return { status: 'ok' };
    }

    // Unknown event type
    return { status: 'ignored' };
  });
};

export default internalRoutes;
