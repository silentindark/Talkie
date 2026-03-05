import { eq, and, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

// Get or create a conversation between two numbers for an account.
// Conversations are keyed by the sorted pair of numbers so inbound/outbound share the same thread.
export async function getOrCreateConversation(
  accountId: string,
  numberA: string,
  numberB: string,
): Promise<{ id: string; isNew: boolean }> {
  // Normalize: always store the lower number as from_number
  const [fromNumber, toNumber] = [numberA, numberB].sort();

  const [existing] = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.accountId, accountId),
        eq(schema.conversations.fromNumber, fromNumber),
        eq(schema.conversations.toNumber, toNumber),
      ),
    )
    .limit(1);

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      accountId,
      fromNumber,
      toNumber,
    })
    .onConflictDoNothing()
    .returning();

  // Handle race condition: if onConflictDoNothing returned nothing, fetch the existing one
  if (!conversation) {
    const [raceExisting] = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.accountId, accountId),
          eq(schema.conversations.fromNumber, fromNumber),
          eq(schema.conversations.toNumber, toNumber),
        ),
      )
      .limit(1);
    return { id: raceExisting.id, isNew: false };
  }

  return { id: conversation.id, isNew: true };
}

export async function updateConversationLastMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  await db
    .update(schema.conversations)
    .set({
      lastMessageId: messageId,
      lastMessageAt: new Date(),
      messageCount: sql`${schema.conversations.messageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, conversationId));
}
