import { createHash } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = 'tk_' + Buffer.from(bytes).toString('base64url');
  const prefix = key.slice(0, 10);
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

export async function authenticateApiKey(key: string) {
  const hash = hashApiKey(key);
  const now = new Date();

  const [apiKey] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, hash))
    .limit(1);

  if (!apiKey) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < now) return null;

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, apiKey.accountId), eq(schema.accounts.status, 'active')))
    .limit(1);

  if (!account) return null;

  // Update last used (fire and forget)
  db.update(schema.apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(schema.apiKeys.id, apiKey.id))
    .then(() => {});

  return { account, apiKey };
}
