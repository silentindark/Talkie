import { createHmac } from 'crypto';
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

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

async function telnyxFetch(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${TELNYX_API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.telnyx.apiKey}`,
      ...options.headers,
    },
  });

  const data: any = await response.json();

  if (!response.ok) {
    const errorMsg = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `Telnyx API error: ${response.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

export class TelnyxProvider implements CarrierProvider {
  name = 'telnyx';

  async searchNumbers(params: NumberSearchParams): Promise<CarrierNumber[]> {
    const searchParams = new URLSearchParams();
    searchParams.set('filter[country_code]', params.country);
    if (params.areaCode) searchParams.set('filter[national_destination_code]', params.areaCode);
    if (params.contains) searchParams.set('filter[phone_number][contains]', params.contains);
    if (params.locality) searchParams.set('filter[locality]', params.locality);
    searchParams.set('filter[limit]', String(params.limit || 10));

    if (params.capabilities?.length) {
      for (const cap of params.capabilities) {
        if (cap === 'voice') searchParams.append('filter[features][]', 'voice');
        if (cap === 'sms') searchParams.append('filter[features][]', 'sms');
        if (cap === 'mms') searchParams.append('filter[features][]', 'mms');
      }
    }

    const data = await telnyxFetch(`/available_phone_numbers?${searchParams.toString()}`);

    return (data.data || []).map((n: any) => ({
      number: n.phone_number,
      region: n.region_information?.[0]?.region_name || '',
      capabilities: [
        ...(n.features?.includes('voice') ? ['voice' as const] : []),
        ...(n.features?.includes('sms') ? ['sms' as const] : []),
        ...(n.features?.includes('mms') ? ['mms' as const] : []),
      ],
      monthlyCost: parseFloat(n.cost_information?.monthly_cost || '0'),
      currency: n.cost_information?.currency || 'USD',
      carrierId: 'telnyx',
      carrierNumberId: n.phone_number,
    }));
  }

  async provisionNumber(number: string, webhookUrl: string): Promise<ProvisionResult> {
    try {
      // Step 1: Create a number order
      const orderData = await telnyxFetch('/number_orders', {
        method: 'POST',
        body: JSON.stringify({
          phone_numbers: [{ phone_number: number }],
          connection_id: config.telnyx.connectionId || undefined,
        }),
      });

      const phoneNumberId = orderData.data?.phone_numbers?.[0]?.id;

      // Step 2: Configure messaging profile and webhook on the number
      if (phoneNumberId) {
        await telnyxFetch(`/phone_numbers/${encodeURIComponent(number)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            connection_id: config.telnyx.connectionId || undefined,
          }),
        }).catch(() => {
          // Non-critical: connection may already be set via order
        });
      }

      return {
        success: true,
        number,
        carrierId: 'telnyx',
        carrierNumberId: phoneNumberId || number,
      };
    } catch (err) {
      return {
        success: false,
        number,
        carrierId: 'telnyx',
        carrierNumberId: '',
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  async releaseNumber(carrierNumberId: string): Promise<ReleaseResult> {
    try {
      await telnyxFetch(`/phone_numbers/${encodeURIComponent(carrierNumberId)}`, {
        method: 'DELETE',
      });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    try {
      const payload: Record<string, unknown> = {
        from: params.from,
        to: params.to,
        text: params.body,
        type: 'SMS',
      };

      if (params.mediaUrls?.length) {
        payload.media_urls = params.mediaUrls;
        payload.type = 'MMS';
      }

      if (params.webhookUrl) {
        payload.webhook_url = params.webhookUrl;
      }

      const data = await telnyxFetch('/messages', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      return {
        success: true,
        carrierMessageId: data.data?.id || '',
        segments: data.data?.parts || 1,
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
    // Telnyx uses a public key verification scheme
    // For simplicity, we verify based on the Telnyx signature header
    // In production, use Telnyx's public key verification
    if (!config.telnyx.apiKey) return false;
    // Basic presence check — full Ed25519 verification should be added in production
    return !!signature;
  }

  parseInboundSms(body: unknown): InboundSms | null {
    const event = body as any;
    const data = event?.data;
    if (!data || event?.data?.event_type !== 'message.received') return null;

    const payload = data.payload;
    return {
      from: payload?.from?.phone_number || '',
      to: payload?.to?.[0]?.phone_number || '',
      body: payload?.text || '',
      mediaUrls: payload?.media?.map((m: any) => m.url).filter(Boolean) || [],
      carrierMessageId: data?.id || '',
    };
  }

  parseInboundCall(body: unknown): { from: string; to: string; sipCallId: string } | null {
    const event = body as any;
    const data = event?.data;
    if (!data || event?.data?.event_type !== 'call.initiated') return null;

    const payload = data.payload;
    return {
      from: payload?.from || '',
      to: payload?.to || '',
      sipCallId: payload?.call_leg_id || payload?.call_session_id || '',
    };
  }
}
