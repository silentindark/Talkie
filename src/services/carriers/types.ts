export interface CarrierNumber {
  number: string;
  region: string;
  capabilities: ('voice' | 'sms' | 'mms')[];
  monthlyCost: number;
  currency: string;
  carrierId: string;
  carrierNumberId: string;
}

export interface NumberSearchParams {
  country: string;
  areaCode?: string;
  contains?: string;
  locality?: string;
  limit?: number;
  capabilities?: ('voice' | 'sms' | 'mms')[];
}

export interface ProvisionResult {
  success: boolean;
  number: string;
  carrierId: string;
  carrierNumberId: string;
  error?: string;
}

export interface ReleaseResult {
  success: boolean;
  error?: string;
}

export interface SendSmsParams {
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  webhookUrl?: string;
}

export interface SendSmsResult {
  success: boolean;
  carrierMessageId: string;
  segments: number;
  error?: string;
}

export interface InboundSms {
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  carrierMessageId: string;
}

export interface CarrierProvider {
  name: string;

  searchNumbers(params: NumberSearchParams): Promise<CarrierNumber[]>;
  provisionNumber(number: string, webhookUrl: string): Promise<ProvisionResult>;
  releaseNumber(carrierNumberId: string): Promise<ReleaseResult>;

  sendSms(params: SendSmsParams): Promise<SendSmsResult>;

  // Verify inbound webhook signature
  verifyWebhook(payload: string, signature: string): boolean;
  parseInboundSms(body: unknown): InboundSms | null;
  parseInboundCall(body: unknown): { from: string; to: string; sipCallId: string } | null;
}
