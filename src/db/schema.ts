import { pgTable, text, timestamp, varchar, integer, boolean, jsonb, pgEnum, uuid, bigint } from 'drizzle-orm/pg-core';

// --- Enums ---

export const accountStatusEnum = pgEnum('account_status', ['active', 'suspended', 'closed']);
export const callStatusEnum = pgEnum('call_status', [
  'queued', 'initiating', 'ringing', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'canceled',
]);
export const callDirectionEnum = pgEnum('call_direction', ['inbound', 'outbound']);
export const messageStatusEnum = pgEnum('message_status', [
  'queued', 'sending', 'sent', 'delivered', 'failed', 'received',
]);
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const numberStatusEnum = pgEnum('number_status', ['active', 'released', 'pending']);
export const numberCapabilityEnum = pgEnum('number_capability', ['voice', 'sms', 'mms', 'fax']);

// --- Tables ---

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  status: accountStatusEnum('status').notNull().default('active'),
  webhookUrl: text('webhook_url'),
  webhookSecret: varchar('webhook_secret', { length: 64 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  keyHash: varchar('key_hash', { length: 128 }).notNull().unique(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  label: varchar('label', { length: 255 }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const phoneNumbers = pgTable('phone_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id),
  number: varchar('number', { length: 20 }).notNull().unique(),
  friendlyName: varchar('friendly_name', { length: 255 }),
  status: numberStatusEnum('status').notNull().default('active'),
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default(['voice', 'sms']),
  region: varchar('region', { length: 10 }),
  carrierId: varchar('carrier_id', { length: 255 }),
  carrierNumberId: varchar('carrier_number_id', { length: 255 }),
  voiceWebhookUrl: text('voice_webhook_url'),
  smsWebhookUrl: text('sms_webhook_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  direction: callDirectionEnum('direction').notNull(),
  from: varchar('from_number', { length: 20 }).notNull(),
  to: varchar('to_number', { length: 20 }).notNull(),
  status: callStatusEnum('status').notNull().default('queued'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  sipCallId: varchar('sip_call_id', { length: 255 }),
  freeswitchUuid: varchar('freeswitch_uuid', { length: 64 }),
  agentId: varchar('agent_id', { length: 255 }),
  agentConfig: jsonb('agent_config'),
  webhookUrl: text('webhook_url'),
  recordingUrl: text('recording_url'),
  metadata: jsonb('metadata'),
  priceUnit: varchar('price_unit', { length: 3 }).default('USD'),
  priceCents: integer('price_cents'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  conversationId: uuid('conversation_id'),
  direction: messageDirectionEnum('direction').notNull(),
  from: varchar('from_number', { length: 20 }).notNull(),
  to: varchar('to_number', { length: 20 }).notNull(),
  body: text('body'),
  mediaUrls: jsonb('media_urls').$type<string[]>(),
  status: messageStatusEnum('status').notNull().default('queued'),
  segments: integer('segments').default(1),
  carrierId: varchar('carrier_id', { length: 255 }),
  carrierMessageId: varchar('carrier_message_id', { length: 255 }),
  errorCode: varchar('error_code', { length: 20 }),
  errorMessage: text('error_message'),
  webhookUrl: text('webhook_url'),
  metadata: jsonb('metadata'),
  priceCents: integer('price_cents'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  fromNumber: varchar('from_number', { length: 20 }).notNull(),
  toNumber: varchar('to_number', { length: 20 }).notNull(),
  lastMessageId: uuid('last_message_id'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  messageCount: integer('message_count').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const smsOptOuts = pgTable('sms_opt_outs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  fromNumber: varchar('from_number', { length: 20 }).notNull(),
  toNumber: varchar('to_number', { length: 20 }).notNull(),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
  optedInAt: timestamp('opted_in_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
});

export const scheduledMessages = pgTable('scheduled_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  from: varchar('from_number', { length: 20 }).notNull(),
  to: varchar('to_number', { length: 20 }).notNull(),
  body: text('body'),
  mediaUrls: jsonb('media_urls').$type<string[]>(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  messageId: uuid('message_id'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  webhookUrl: text('webhook_url'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const callEvents = pgTable('call_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  callId: uuid('call_id').notNull().references(() => calls.id),
  event: varchar('event', { length: 50 }).notNull(),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  url: text('url').notNull(),
  event: varchar('event', { length: 50 }).notNull(),
  payload: jsonb('payload').notNull(),
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  attempt: integer('attempt').notNull().default(1),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
