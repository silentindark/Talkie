import { createHmac } from 'crypto';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';

interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
  callId?: string;
  messageId?: string;
}

export async function deliverWebhook(
  accountId: string,
  url: string,
  event: string,
  data: Record<string, unknown>,
  secret?: string | null,
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    data,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Talkie-Webhook/1.0',
    'X-Talkie-Event': event,
  };

  if (secret) {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Talkie-Signature'] = signature;
  }

  let statusCode: number | null = null;
  let responseBody: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.webhook.timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    statusCode = response.status;
    responseBody = await response.text().catch(() => null);

    await db.insert(schema.webhookDeliveries).values({
      accountId,
      url,
      event,
      payload,
      statusCode,
      responseBody,
      attempt: 1,
      deliveredAt: new Date(),
    });

    if (!response.ok) {
      await scheduleRetry(accountId, url, event, payload, 2);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await db.insert(schema.webhookDeliveries).values({
      accountId,
      url,
      event,
      payload,
      responseBody: errorMessage,
      attempt: 1,
    });
    await scheduleRetry(accountId, url, event, payload, 2);
  }
}

async function scheduleRetry(
  accountId: string,
  url: string,
  event: string,
  payload: WebhookPayload,
  attempt: number,
): Promise<void> {
  if (attempt > config.webhook.maxRetries) return;

  // Exponential backoff: 5s, 25s, 125s
  const delayMs = Math.pow(5, attempt) * 1000;
  const nextRetryAt = new Date(Date.now() + delayMs);

  await db.insert(schema.webhookDeliveries).values({
    accountId,
    url,
    event,
    payload,
    attempt,
    nextRetryAt,
  });
}

export async function emitCallEvent(
  accountId: string,
  callId: string,
  event: string,
  data: Record<string, unknown>,
  webhookUrl?: string | null,
  webhookSecret?: string | null,
): Promise<void> {
  // Store the event
  await db.insert(schema.callEvents).values({
    callId,
    event,
    data,
  });

  // Deliver webhook if URL is configured
  if (webhookUrl) {
    // Fire and forget — don't block call processing
    deliverWebhook(accountId, webhookUrl, event, { callId, ...data }, webhookSecret).catch((err) => {
      console.error(`[Webhook] Failed to deliver ${event} for call ${callId}:`, err);
    });
  }
}
