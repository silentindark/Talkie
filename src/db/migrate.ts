import postgres from 'postgres';
import { config } from '../config.js';

const sql = postgres(config.db.url);

async function migrate() {
  console.log('Running migrations...');

  await sql`
    DO $$ BEGIN
      CREATE TYPE account_status AS ENUM ('active', 'suspended', 'closed');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE call_status AS ENUM ('queued', 'initiating', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'canceled');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE message_status AS ENUM ('queued', 'sending', 'sent', 'delivered', 'failed', 'received');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;
  await sql`
    DO $$ BEGIN
      CREATE TYPE number_status AS ENUM ('active', 'released', 'pending');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      status account_status NOT NULL DEFAULT 'active',
      webhook_url TEXT,
      webhook_secret VARCHAR(64),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      key_hash VARCHAR(128) NOT NULL UNIQUE,
      key_prefix VARCHAR(12) NOT NULL,
      label VARCHAR(255),
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID REFERENCES accounts(id),
      number VARCHAR(20) NOT NULL UNIQUE,
      friendly_name VARCHAR(255),
      status number_status NOT NULL DEFAULT 'active',
      capabilities JSONB NOT NULL DEFAULT '["voice","sms"]',
      region VARCHAR(10),
      carrier_id VARCHAR(255),
      carrier_number_id VARCHAR(255),
      voice_webhook_url TEXT,
      sms_webhook_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      direction call_direction NOT NULL,
      from_number VARCHAR(20) NOT NULL,
      to_number VARCHAR(20) NOT NULL,
      status call_status NOT NULL DEFAULT 'queued',
      answered_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      sip_call_id VARCHAR(255),
      freeswitch_uuid VARCHAR(64),
      agent_id VARCHAR(255),
      agent_config JSONB,
      webhook_url TEXT,
      recording_url TEXT,
      metadata JSONB,
      price_unit VARCHAR(3) DEFAULT 'USD',
      price_cents INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      direction message_direction NOT NULL,
      from_number VARCHAR(20) NOT NULL,
      to_number VARCHAR(20) NOT NULL,
      body TEXT,
      media_urls JSONB,
      status message_status NOT NULL DEFAULT 'queued',
      segments INTEGER DEFAULT 1,
      carrier_id VARCHAR(255),
      carrier_message_id VARCHAR(255),
      error_code VARCHAR(20),
      error_message TEXT,
      webhook_url TEXT,
      metadata JSONB,
      price_cents INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS call_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      call_id UUID NOT NULL REFERENCES calls(id),
      event VARCHAR(50) NOT NULL,
      data JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      url TEXT NOT NULL,
      event VARCHAR(50) NOT NULL,
      payload JSONB NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      delivered_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      from_number VARCHAR(20) NOT NULL,
      to_number VARCHAR(20) NOT NULL,
      last_message_id UUID,
      last_message_at TIMESTAMPTZ,
      message_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id, from_number, to_number)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sms_opt_outs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      from_number VARCHAR(20) NOT NULL,
      to_number VARCHAR(20) NOT NULL,
      opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opted_in_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(account_id, from_number, to_number)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      from_number VARCHAR(20) NOT NULL,
      to_number VARCHAR(20) NOT NULL,
      body TEXT,
      media_urls JSONB,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      message_id UUID,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      webhook_url TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Add conversation_id to messages if not exists
  await sql`
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN conversation_id UUID REFERENCES conversations(id);
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;
  `;

  // Indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_phone_numbers_account ON phone_numbers(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_account ON calls(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calls_freeswitch_uuid ON calls(freeswitch_uuid);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_account ON webhook_deliveries(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE next_retry_at IS NOT NULL;`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_numbers ON conversations(account_id, from_number, to_number);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_numbers ON sms_opt_outs(account_id, from_number, to_number) WHERE is_active = true;`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending ON scheduled_messages(scheduled_at) WHERE status = 'pending';`;

  console.log('Migrations complete.');
  await sql.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
