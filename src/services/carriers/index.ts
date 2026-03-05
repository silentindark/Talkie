import { TelnyxProvider } from './telnyx.js';
import { BandwidthProvider } from './bandwidth.js';
import type { CarrierProvider } from './types.js';

export type { CarrierProvider, CarrierNumber, NumberSearchParams, SendSmsParams, SendSmsResult, InboundSms } from './types.js';

const providers: Record<string, CarrierProvider> = {
  telnyx: new TelnyxProvider(),
  bandwidth: new BandwidthProvider(),
};

export function getCarrier(name = 'telnyx'): CarrierProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown carrier: ${name}`);
  return provider;
}

export function getDefaultCarrier(): CarrierProvider {
  return providers.telnyx;
}

export function registerCarrier(name: string, provider: CarrierProvider): void {
  providers[name] = provider;
}
