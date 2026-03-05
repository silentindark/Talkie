import { config } from '../../config.js';
import type {
  CarrierProvider,
  CarrierNumber,
  NumberSearchParams,
  ProvisionResult,
  ReleaseResult,
  SendSmsParams,
  SendSmsResult,
  InboundSms,
} from './types.js';

const BANDWIDTH_API_BASE = 'https://dashboard.bandwidth.com/api';
const BANDWIDTH_MSG_BASE = 'https://messaging.bandwidth.com/api/v2';

function getBandwidthAuth(): string {
  return Buffer.from(`${config.bandwidth.apiUser}:${config.bandwidth.apiPassword}`).toString('base64');
}

async function bandwidthFetch(base: string, path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${getBandwidthAuth()}`,
      ...options.headers,
    },
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(typeof data === 'string' ? data : data?.message || `Bandwidth API error: ${response.status}`);
  }

  return data;
}

export class BandwidthProvider implements CarrierProvider {
  name = 'bandwidth';

  async searchNumbers(params: NumberSearchParams): Promise<CarrierNumber[]> {
    const searchParams = new URLSearchParams();
    if (params.areaCode) searchParams.set('areaCode', params.areaCode);
    if (params.locality) searchParams.set('city', params.locality);
    searchParams.set('quantity', String(params.limit || 10));

    const data = await bandwidthFetch(
      BANDWIDTH_API_BASE,
      `/accounts/${config.bandwidth.accountId}/availableNumbers?${searchParams.toString()}`,
    );

    const numbers = Array.isArray(data) ? data : data?.TelephoneNumberList?.TelephoneNumber || [];
    return numbers.map((n: any) => ({
      number: `+1${typeof n === 'string' ? n : n.FullNumber}`,
      region: typeof n === 'string' ? '' : n.City || '',
      capabilities: ['voice', 'sms'] as ('voice' | 'sms')[],
      monthlyCost: 1.00,
      currency: 'USD',
      carrierId: 'bandwidth',
      carrierNumberId: typeof n === 'string' ? n : n.FullNumber,
    }));
  }

  async provisionNumber(number: string, webhookUrl: string): Promise<ProvisionResult> {
    try {
      const bareNumber = number.replace(/^\+1/, '');

      await bandwidthFetch(
        BANDWIDTH_API_BASE,
        `/accounts/${config.bandwidth.accountId}/orders`,
        {
          method: 'POST',
          body: JSON.stringify({
            Order: {
              Name: `Talkie-${Date.now()}`,
              SiteId: config.bandwidth.siteId,
              ExistingTelephoneNumberOrderType: {
                TelephoneNumberList: {
                  TelephoneNumber: [bareNumber],
                },
              },
            },
          }),
        },
      );

      return {
        success: true,
        number,
        carrierId: 'bandwidth',
        carrierNumberId: bareNumber,
      };
    } catch (err) {
      return {
        success: false,
        number,
        carrierId: 'bandwidth',
        carrierNumberId: '',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  async releaseNumber(carrierNumberId: string): Promise<ReleaseResult> {
    try {
      await bandwidthFetch(
        BANDWIDTH_API_BASE,
        `/accounts/${config.bandwidth.accountId}/disconnects`,
        {
          method: 'POST',
          body: JSON.stringify({
            DisconnectTelephoneNumberOrder: {
              Name: `Talkie-disconnect-${Date.now()}`,
              DisconnectTelephoneNumberOrderType: {
                TelephoneNumberList: {
                  TelephoneNumber: [carrierNumberId],
                },
              },
            },
          }),
        },
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    try {
      const payload: Record<string, unknown> = {
        from: params.from,
        to: [params.to],
        text: params.body,
        applicationId: config.bandwidth.applicationId,
      };

      if (params.mediaUrls?.length) {
        payload.media = params.mediaUrls;
      }

      const data = await bandwidthFetch(
        BANDWIDTH_MSG_BASE,
        `/users/${config.bandwidth.accountId}/messages`,
        { method: 'POST', body: JSON.stringify(payload) },
      );

      return {
        success: true,
        carrierMessageId: data.id || '',
        segments: data.segmentCount || 1,
      };
    } catch (err) {
      return {
        success: false,
        carrierMessageId: '',
        segments: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  verifyWebhook(payload: string, signature: string): boolean {
    return !!signature;
  }

  parseInboundSms(body: unknown): InboundSms | null {
    const event = body as any;
    if (!event || event.type !== 'message-received') return null;

    const message = event.message;
    return {
      from: message?.from || '',
      to: message?.to?.[0] || '',
      body: message?.text || '',
      mediaUrls: message?.media?.map((m: string) => m) || [],
      carrierMessageId: message?.id || '',
    };
  }

  parseInboundCall(body: unknown): { from: string; to: string; sipCallId: string } | null {
    const event = body as any;
    if (!event || event.eventType !== 'initiate') return null;

    return {
      from: event.from || '',
      to: event.to || '',
      sipCallId: event.callId || '',
    };
  }
}
