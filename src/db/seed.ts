import postgres from 'postgres';
import { createHash, randomBytes } from 'crypto';
import { config } from '../config.js';

const sql = postgres(config.db.url);

async function seed() {
  console.log('Seeding database...');

  // Create a test account
  const accountId = crypto.randomUUID();
  const webhookSecret = randomBytes(32).toString('hex');

  await sql`
    INSERT INTO accounts (id, name, email, webhook_secret)
    VALUES (${accountId}, 'Test Account', 'test@talkie.dev', ${webhookSecret})
    ON CONFLICT (email) DO NOTHING
  `;

  // Create a test API key: tk_test_development_key_12345
  const testKey = 'tk_test_development_key_12345';
  const keyHash = createHash('sha256').update(testKey).digest('hex');

  await sql`
    INSERT INTO api_keys (account_id, key_hash, key_prefix, label)
    VALUES (${accountId}, ${keyHash}, 'tk_test_de', 'Development Key')
    ON CONFLICT (key_hash) DO NOTHING
  `;

  // Create a test phone number
  await sql`
    INSERT INTO phone_numbers (account_id, number, friendly_name, status, capabilities)
    VALUES (${accountId}, '+15551234567', 'Test Number', 'active', '["voice","sms"]')
    ON CONFLICT (number) DO NOTHING
  `;

  console.log('Seed complete.');
  console.log(`  Account ID: ${accountId}`);
  console.log(`  API Key:    ${testKey}`);
  console.log(`  Phone:      +15551234567`);

  await sql.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
