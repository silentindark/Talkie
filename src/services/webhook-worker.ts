import { eq, and, lte, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { createHmac } from 'crypto';
import { config } from '../config.js';

let intervalId: ReturnType<typeof setInterval> | null = null;

// Poll for webhook retries every 15 seconds
export function startWebhookWorker(): void {
  if (intervalId) return;

  console.log('[WebhookWorker] Started — checking for retries every 15s');
  intervalId = setInterval(processRetries, 15_000);
}

export function stopWebhookWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function processRetries(): Promise<void> {
  try {
    const now = new Date();

    // Find webhook deliveries that need retrying
    const pending = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          isNotNull(schema.webhookDeliveries.nextRetryAt),
          lte(schema.webhookDeliveries.nextRetryAt, now),
        ),
      )
      .limit(20);

    if (pending.length === 0) return;

    for (const delivery of pending) {
      try {
        const body = JSON.stringify(delivery.payload);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Talkie-Webhook/1.0',
          'X-Talkie-Event': delivery.event,
          'X-Talkie-Retry': String(delivery.attempt),
        };

        // Fetch account for webhook secret
        const [account] = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, delivery.accountId))
          .limit(1);

        if (account?.webhookSecret) {
          const signature = createHmac('sha256', account.webhookSecret).update(body).digest('hex');
          headers['X-Talkie-Signature'] = signature;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.webhook.timeoutMs);

        const response = await fetch(delivery.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          // Success — clear retry
          await db
            .update(schema.webhookDeliveries)
            .set({
              statusCode: response.status,
              deliveredAt: new Date(),
              nextRetryAt: null,
            })
            .where(eq(schema.webhookDeliveries.id, delivery.id));
        } else {
          // Failed — schedule next retry or give up
          const nextAttempt = delivery.attempt + 1;
          if (nextAttempt > config.webhook.maxRetries) {
            await db
              .update(schema.webhookDeliveries)
              .set({
                statusCode: response.status,
                nextRetryAt: null,
              })
              .where(eq(schema.webhookDeliveries.id, delivery.id));
          } else {
            const delayMs = Math.pow(5, nextAttempt) * 1000;
            await db
              .update(schema.webhookDeliveries)
              .set({
                statusCode: response.status,
                attempt: nextAttempt,
                nextRetryAt: new Date(Date.now() + delayMs),
              })
              .where(eq(schema.webhookDeliveries.id, delivery.id));
          }
        }
      } catch (err) {
        // Network error — schedule retry
        const nextAttempt = delivery.attempt + 1;
        if (nextAttempt <= config.webhook.maxRetries) {
          const delayMs = Math.pow(5, nextAttempt) * 1000;
          await db
            .update(schema.webhookDeliveries)
            .set({
              attempt: nextAttempt,
              nextRetryAt: new Date(Date.now() + delayMs),
              responseBody: err instanceof Error ? err.message : 'Unknown error',
            })
            .where(eq(schema.webhookDeliveries.id, delivery.id));
        } else {
          await db
            .update(schema.webhookDeliveries)
            .set({ nextRetryAt: null })
            .where(eq(schema.webhookDeliveries.id, delivery.id));
        }
      }
    }
  } catch (err) {
    console.error('[WebhookWorker] Error processing retries:', err);
  }
}
