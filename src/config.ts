import 'dotenv/config';

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  db: {
    url: process.env.DATABASE_URL || 'postgres://talkie:talkie@localhost:5432/talkie',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  freeswitch: {
    host: process.env.FREESWITCH_HOST || 'localhost',
    port: parseInt(process.env.FREESWITCH_PORT || '8021', 10),
    password: process.env.FREESWITCH_PASSWORD || 'ClueCon',
  },
  telnyx: {
    apiKey: process.env.TELNYX_API_KEY || '',
    sipTrunkIp: process.env.TELNYX_SIP_TRUNK_IP || '',
    connectionId: process.env.TELNYX_CONNECTION_ID || '',
  },
  bandwidth: {
    accountId: process.env.BANDWIDTH_ACCOUNT_ID || '',
    apiUser: process.env.BANDWIDTH_API_USER || '',
    apiPassword: process.env.BANDWIDTH_API_PASSWORD || '',
    applicationId: process.env.BANDWIDTH_APPLICATION_ID || '',
    siteId: process.env.BANDWIDTH_SITE_ID || '',
  },
  webhook: {
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
  },
  audio: {
    sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE || '8000', 10),
    channels: parseInt(process.env.AUDIO_CHANNELS || '1', 10),
    frameSizeMs: parseInt(process.env.AUDIO_FRAME_SIZE_MS || '20', 10),
  },
} as const;
