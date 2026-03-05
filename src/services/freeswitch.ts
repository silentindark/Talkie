import { EventEmitter } from 'events';
import { config } from '../config.js';

interface ESLConnection {
  connected: boolean;
  api(command: string): Promise<string>;
  bgapi(command: string): Promise<string>;
  subscribe(events: string[]): Promise<void>;
  on(event: string, handler: (data: any) => void): void;
  disconnect(): void;
}

class FreeSwitchService extends EventEmitter {
  private connection: ESLConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  async connect(): Promise<void> {
    // ESL connection will be established when FreeSWITCH is available
    // For now, we emit a mock connection for development
    console.log(`[FreeSWITCH] Connecting to ${config.freeswitch.host}:${config.freeswitch.port}...`);

    try {
      // Dynamic import of esl module - will work when FreeSWITCH is running
      const modesl = await import('modesl');
      const Connection = modesl.default?.Connection || modesl.Connection;

      return new Promise((resolve, reject) => {
        const conn = new Connection(
          config.freeswitch.host,
          config.freeswitch.port,
          config.freeswitch.password,
          () => {
            console.log('[FreeSWITCH] Connected via ESL');
            this.connection = this.wrapConnection(conn);
            this.reconnectAttempts = 0;
            this.emit('connected');
            resolve();
          }
        );

        conn.on('error', (err: Error) => {
          console.error('[FreeSWITCH] ESL connection error:', err.message);
          this.scheduleReconnect();
          reject(err);
        });

        conn.on('esl::end', () => {
          console.warn('[FreeSWITCH] ESL connection closed');
          this.connection = null;
          this.emit('disconnected');
          this.scheduleReconnect();
        });

        // Forward relevant events
        conn.on('esl::event::CHANNEL_ANSWER::*', (evt: any) => {
          this.emit('call.answered', this.parseEvent(evt));
        });
        conn.on('esl::event::CHANNEL_HANGUP_COMPLETE::*', (evt: any) => {
          this.emit('call.completed', this.parseEvent(evt));
        });
        conn.on('esl::event::CHANNEL_STATE::*', (evt: any) => {
          this.emit('call.state', this.parseEvent(evt));
        });
      });
    } catch (err) {
      console.warn('[FreeSWITCH] ESL not available, running in API-only mode');
      this.scheduleReconnect();
    }
  }

  private wrapConnection(conn: any): ESLConnection {
    return {
      connected: true,
      api: (cmd: string) => new Promise((resolve, reject) => {
        conn.api(cmd, (res: any) => {
          const body = res?.getBody?.() || res?.body || '';
          if (body.startsWith('-ERR')) reject(new Error(body));
          else resolve(body);
        });
      }),
      bgapi: (cmd: string) => new Promise((resolve, reject) => {
        conn.bgapi(cmd, (res: any) => {
          const body = res?.getBody?.() || res?.body || '';
          resolve(body);
        });
      }),
      subscribe: (events: string[]) => new Promise((resolve) => {
        conn.subscribe(events, () => resolve());
      }),
      on: (event: string, handler: (data: any) => void) => conn.on(event, handler),
      disconnect: () => conn.disconnect(),
    };
  }

  private parseEvent(evt: any): Record<string, string> {
    const headers: Record<string, string> = {};
    const body = evt?.getBody?.() || '';
    if (evt?.getHeader) {
      for (const key of ['Unique-ID', 'Channel-State', 'Caller-Caller-ID-Number', 'Caller-Destination-Number', 'Hangup-Cause', 'variable_duration']) {
        const val = evt.getHeader(key);
        if (val) headers[key] = val;
      }
    }
    return headers;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[FreeSWITCH] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.connect(); } catch {}
    }, delay);
  }

  get isConnected(): boolean {
    return this.connection?.connected ?? false;
  }

  async originate(params: {
    to: string;
    from: string;
    gateway: string;
    callUuid: string;
    audioStreamUrl?: string;
  }): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');

    const { to, from, gateway, callUuid, audioStreamUrl } = params;
    const vars = [
      `origination_uuid=${callUuid}`,
      `origination_caller_id_number=${from}`,
      `origination_caller_id_name=${from}`,
      `talkie_call_id=${callUuid}`,
    ];

    if (audioStreamUrl) {
      vars.push(`audio_stream_url=${audioStreamUrl}`);
    }

    const varString = `{${vars.join(',')}}`;
    const dialString = `sofia/gateway/${gateway}/${to}`;
    const app = audioStreamUrl ? `&socket(${audioStreamUrl})` : '&park()';

    const cmd = `originate ${varString}${dialString} ${app}`;
    return this.connection.api(cmd);
  }

  async hangup(callUuid: string, cause = 'NORMAL_CLEARING'): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_kill ${callUuid} ${cause}`);
  }

  async transfer(callUuid: string, destination: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_transfer ${callUuid} ${destination}`);
  }

  async bridge(callUuidA: string, callUuidB: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_bridge ${callUuidA} ${callUuidB}`);
  }

  async startAudioStream(callUuid: string, wsUrl: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_audio_stream ${callUuid} start ${wsUrl}`);
  }

  async stopAudioStream(callUuid: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_audio_stream ${callUuid} stop`);
  }

  async playback(callUuid: string, filePath: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_broadcast ${callUuid} ${filePath}`);
  }

  async sendDtmf(callUuid: string, digits: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_send_dtmf ${callUuid} ${digits}`);
  }

  async hold(callUuid: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_hold ${callUuid}`);
  }

  async unhold(callUuid: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_hold off ${callUuid}`);
  }

  async mute(callUuid: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_audio ${callUuid} start read mute`);
  }

  async unmute(callUuid: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_audio ${callUuid} stop`);
  }

  async startRecording(callUuid: string, filePath: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_record ${callUuid} start ${filePath}`);
  }

  async stopRecording(callUuid: string, filePath: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_record ${callUuid} stop ${filePath}`);
  }

  async conference(callUuid: string, conferenceName: string): Promise<string> {
    if (!this.connection) throw new Error('FreeSWITCH not connected');
    return this.connection.api(`uuid_transfer ${callUuid} conference:${conferenceName}@default inline`);
  }

  async getChannelCount(): Promise<number> {
    if (!this.connection) return 0;
    try {
      const result = await this.connection.api('show channels count');
      const match = result.match(/(\d+) total/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connection?.disconnect();
    this.connection = null;
  }
}

export const freeswitchService = new FreeSwitchService();
