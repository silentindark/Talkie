import { eq, and, lte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getDefaultCarrier } from './carriers/index.js';
import { config } from '../config.js';

let intervalId: ReturnType<typeof setInterval> | null = null;

// Poll for scheduled messages every 10 seconds and send them
export function startScheduler(): void {
  if (intervalId) return;

  console.log('[Scheduler] Started — checking for scheduled messages every 10s');
  intervalId = setInterval(processScheduledMessages, 10_000);
  // Also run immediately
  processScheduledMessages();
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function processScheduledMessages(): Promise<void> {
  try {
    const now = new Date();

    // Find pending scheduled messages that are due
    const pending = await db
      .select()
      .from(schema.scheduledMessages)
      .where(
        and(
          eq(schema.scheduledMessages.status, 'pending'),
          lte(schema.scheduledMessages.scheduledAt, now),
        ),
      )
      .limit(50);

    if (pending.length === 0) return;

    const carrier = getDefaultCarrier();

    for (const scheduled of pending) {
      try {
        // Mark as processing
        await db
          .update(schema.scheduledMessages)
          .set({ status: 'processing' })
          .where(eq(schema.scheduledMessages.id, scheduled.id));

        // Create the message record
        const [message] = await db
          .insert(schema.messages)
          .values({
            accountId: scheduled.accountId,
            direction: 'outbound',
            from: scheduled.from,
            to: scheduled.to,
            body: scheduled.body,
            mediaUrls: scheduled.mediaUrls,
            status: 'queued',
            webhookUrl: scheduled.webhookUrl,
            metadata: scheduled.metadata,
          })
          .returning();

        // Send via carrier
        if (config.telnyx.apiKey) {
          const result = await carrier.sendSms({
            from: scheduled.from,
            to: scheduled.to,
            body: scheduled.body || '',
            mediaUrls: scheduled.mediaUrls || undefined,
          });

          await db
            .update(schema.messages)
            .set({
              status: result.success ? 'sending' : 'failed',
              carrierMessageId: result.carrierMessageId || undefined,
              carrierId: carrier.name,
              errorMessage: result.error || undefined,
              updatedAt: new Date(),
            })
            .where(eq(schema.messages.id, message.id));
        }

        // Mark scheduled message as sent
        await db
          .update(schema.scheduledMessages)
          .set({
            status: 'sent',
            sentAt: new Date(),
            messageId: message.id,
          })
          .where(eq(schema.scheduledMessages.id, scheduled.id));
      } catch (err) {
        console.error(`[Scheduler] Failed to send scheduled message ${scheduled.id}:`, err);
        await db
          .update(schema.scheduledMessages)
          .set({ status: 'failed' })
          .where(eq(schema.scheduledMessages.id, scheduled.id));
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error processing scheduled messages:', err);
  }
}
