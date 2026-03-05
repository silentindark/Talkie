import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const OPT_IN_KEYWORDS = ['START', 'YES', 'UNSTOP', 'SUBSCRIBE'];

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.includes(text.trim().toUpperCase());
}

export function isOptInKeyword(text: string): boolean {
  return OPT_IN_KEYWORDS.includes(text.trim().toUpperCase());
}

// Check if a number has opted out of receiving messages from a specific sender
export async function isOptedOut(
  accountId: string,
  senderNumber: string,
  recipientNumber: string,
): Promise<boolean> {
  const [optOut] = await db
    .select()
    .from(schema.smsOptOuts)
    .where(
      and(
        eq(schema.smsOptOuts.accountId, accountId),
        eq(schema.smsOptOuts.fromNumber, senderNumber),
        eq(schema.smsOptOuts.toNumber, recipientNumber),
        eq(schema.smsOptOuts.isActive, true),
      ),
    )
    .limit(1);

  return !!optOut;
}

// Record an opt-out (recipient doesn't want messages from sender)
export async function recordOptOut(
  accountId: string,
  senderNumber: string,
  recipientNumber: string,
): Promise<void> {
  await db
    .insert(schema.smsOptOuts)
    .values({
      accountId,
      fromNumber: senderNumber,
      toNumber: recipientNumber,
    })
    .onConflictDoUpdate({
      target: [schema.smsOptOuts.accountId, schema.smsOptOuts.fromNumber, schema.smsOptOuts.toNumber],
      set: {
        isActive: true,
        optedOutAt: new Date(),
        optedInAt: null,
      },
    });
}

// Record an opt-in (recipient wants to receive messages again)
export async function recordOptIn(
  accountId: string,
  senderNumber: string,
  recipientNumber: string,
): Promise<void> {
  await db
    .update(schema.smsOptOuts)
    .set({
      isActive: false,
      optedInAt: new Date(),
    })
    .where(
      and(
        eq(schema.smsOptOuts.accountId, accountId),
        eq(schema.smsOptOuts.fromNumber, senderNumber),
        eq(schema.smsOptOuts.toNumber, recipientNumber),
      ),
    );
}

// Auto-reply when someone opts out
export function getOptOutAutoReply(): string {
  return 'You have been unsubscribed and will no longer receive messages. Reply START to resubscribe.';
}

export function getOptInAutoReply(): string {
  return 'You have been resubscribed and will now receive messages again. Reply STOP to unsubscribe.';
}
