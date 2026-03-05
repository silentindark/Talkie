import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config.js';

// --- Stream Protocol Types ---

// Events sent TO the AI agent (JSON text frames)
export type StreamToAgentEvent =
  | { event: 'stream.started'; callId: string; streamId: string; sampleRate: number; channels: number; encoding: 'linear16'; callFrom: string; callTo: string; callDirection: string }
  | { event: 'stream.ended'; callId: string; reason: string }
  | { event: 'dtmf'; callId: string; digit: string }
  | { event: 'call.answered'; callId: string }
  | { event: 'call.hangup'; callId: string; cause: string }
  | { event: 'speech.started'; callId: string }
  | { event: 'speech.ended'; callId: string; durationMs: number }
  | { event: 'playback.finished'; callId: string; playbackId: string }
  | { event: 'error'; callId: string; message: string };
// Binary frames: raw L16 PCM audio (caller's voice)

// Commands sent FROM the AI agent (JSON text frames)
export type AgentCommand =
  | { command: 'audio.play'; callId: string; playbackId?: string; interrupt?: boolean }
  | { command: 'audio.stop'; callId: string }
  | { command: 'hangup'; callId: string; cause?: string }
  | { command: 'transfer'; callId: string; destination: string }
  | { command: 'send_dtmf'; callId: string; digits: string }
  | { command: 'recording.start'; callId: string }
  | { command: 'recording.stop'; callId: string }
  | { command: 'transcript'; callId: string; role: 'user' | 'assistant'; text: string; final: boolean }
  | { command: 'metadata'; callId: string; data: Record<string, unknown> };
// Binary frames: raw L16 PCM audio (agent's voice to play into call)

interface AudioStreamSession {
  callId: string;
  streamId: string;
  accountId: string;
  agentWs: WebSocket;
  fsWs?: WebSocket;
  sampleRate: number;
  channels: number;
  startedAt: Date;
  callFrom: string;
  callTo: string;
  callDirection: string;
  // Recording state
  isRecording: boolean;
  recordingBuffers: Buffer[];
  // VAD state
  isSpeaking: boolean;
  silenceStart: number;
  speechStart: number;
  // Playback state
  currentPlaybackId: string | null;
  isPlayingAudio: boolean;
  // Metrics
  bytesReceived: number;
  bytesSent: number;
  audioPacketsReceived: number;
  audioPacketsSent: number;
}

class AudioStreamManager extends EventEmitter {
  private sessions = new Map<string, AudioStreamSession>();

  createSession(params: {
    callId: string;
    accountId: string;
    agentWs: WebSocket;
    callFrom: string;
    callTo: string;
    callDirection: string;
  }): AudioStreamSession {
    const { callId, accountId, agentWs, callFrom, callTo, callDirection } = params;
    const streamId = `stream_${callId}_${Date.now()}`;

    const session: AudioStreamSession = {
      callId,
      streamId,
      accountId,
      agentWs,
      sampleRate: config.audio.sampleRate,
      channels: config.audio.channels,
      startedAt: new Date(),
      callFrom,
      callTo,
      callDirection,
      isRecording: false,
      recordingBuffers: [],
      isSpeaking: false,
      silenceStart: 0,
      speechStart: 0,
      currentPlaybackId: null,
      isPlayingAudio: false,
      bytesReceived: 0,
      bytesSent: 0,
      audioPacketsReceived: 0,
      audioPacketsSent: 0,
    };

    this.sessions.set(callId, session);

    // Send stream metadata to agent
    this.sendToAgent(callId, {
      event: 'stream.started',
      callId,
      streamId,
      sampleRate: session.sampleRate,
      channels: session.channels,
      encoding: 'linear16',
      callFrom,
      callTo,
      callDirection,
    });

    agentWs.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        session.bytesSent += buf.length;
        session.audioPacketsSent++;
        // Binary = audio from agent to play into the call
        this.forwardToFreeSWITCH(callId, buf);
      } else {
        // Text = control command from agent
        this.handleAgentCommand(callId, data.toString());
      }
    });

    agentWs.on('close', () => {
      this.endSession(callId, 'agent_disconnected');
    });

    agentWs.on('error', (err) => {
      console.error(`[AudioStream] Agent WS error for call ${callId}:`, err.message);
      this.endSession(callId, 'agent_error');
    });

    return session;
  }

  // Called when FreeSWITCH sends audio via mod_audio_stream
  handleFreeSWITCHAudio(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session || session.agentWs.readyState !== WebSocket.OPEN) return;

    session.bytesReceived += audioData.length;
    session.audioPacketsReceived++;

    // Simple energy-based VAD (Voice Activity Detection)
    const energy = this.calculateEnergy(audioData);
    const SPEECH_THRESHOLD = 500;
    const SILENCE_DURATION_MS = 300;

    if (energy > SPEECH_THRESHOLD) {
      if (!session.isSpeaking) {
        session.isSpeaking = true;
        session.speechStart = Date.now();
        this.sendToAgent(callId, { event: 'speech.started', callId });
      }
      session.silenceStart = 0;
    } else if (session.isSpeaking) {
      if (session.silenceStart === 0) {
        session.silenceStart = Date.now();
      } else if (Date.now() - session.silenceStart > SILENCE_DURATION_MS) {
        session.isSpeaking = false;
        const durationMs = Date.now() - session.speechStart;
        this.sendToAgent(callId, { event: 'speech.ended', callId, durationMs });
      }
    }

    // Record if recording is active
    if (session.isRecording) {
      session.recordingBuffers.push(Buffer.from(audioData));
    }

    // Forward raw L16 PCM audio to agent
    session.agentWs.send(audioData);
  }

  // Called when FreeSWITCH sends events (DTMF, hangup, etc.)
  handleFreeSWITCHEvent(callId: string, event: Record<string, unknown>): void {
    const session = this.sessions.get(callId);
    if (!session || session.agentWs.readyState !== WebSocket.OPEN) return;

    // Map FreeSWITCH events to our stream protocol
    const eventType = event.event_type || event.type;

    if (eventType === 'dtmf' && typeof event.digit === 'string') {
      this.sendToAgent(callId, { event: 'dtmf', callId, digit: event.digit });
    } else if (eventType === 'hangup') {
      this.sendToAgent(callId, { event: 'call.hangup', callId, cause: String(event.cause || 'NORMAL_CLEARING') });
    } else if (eventType === 'answered') {
      this.sendToAgent(callId, { event: 'call.answered', callId });
    } else {
      // Forward unknown events as-is
      session.agentWs.send(JSON.stringify(event));
    }
  }

  private forwardToFreeSWITCH(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.fsWs || session.fsWs.readyState !== WebSocket.OPEN) return;

    session.fsWs.send(audioData);
  }

  private handleAgentCommand(callId: string, rawMessage: string): void {
    try {
      const command = JSON.parse(rawMessage) as AgentCommand;
      const session = this.sessions.get(callId);
      if (!session) return;

      switch (command.command) {
        case 'audio.stop':
          session.isPlayingAudio = false;
          session.currentPlaybackId = null;
          // Tell FreeSWITCH to stop any current playback
          this.emit('agent.command', { callId, command: { action: 'stop_playback' } });
          break;

        case 'hangup':
          this.emit('agent.command', { callId, command: { action: 'hangup', cause: command.cause } });
          break;

        case 'transfer':
          this.emit('agent.command', { callId, command: { action: 'transfer', destination: command.destination } });
          break;

        case 'send_dtmf':
          this.emit('agent.command', { callId, command: { action: 'send_dtmf', digits: command.digits } });
          break;

        case 'recording.start':
          session.isRecording = true;
          session.recordingBuffers = [];
          break;

        case 'recording.stop':
          session.isRecording = false;
          const recording = Buffer.concat(session.recordingBuffers);
          session.recordingBuffers = [];
          this.emit('recording.complete', { callId, accountId: session.accountId, audioData: recording, sampleRate: session.sampleRate });
          break;

        case 'transcript':
          // Emit transcript for webhook delivery
          this.emit('transcript', {
            callId,
            accountId: session.accountId,
            role: command.role,
            text: command.text,
            final: command.final,
          });
          break;

        case 'metadata':
          this.emit('call.metadata', { callId, accountId: session.accountId, data: command.data });
          break;

        default:
          this.sendToAgent(callId, { event: 'error', callId, message: `Unknown command: ${(command as any).command}` });
      }
    } catch {
      console.warn(`[AudioStream] Invalid command from agent for call ${callId}`);
    }
  }

  attachFreeSWITCHSocket(callId: string, ws: WebSocket): void {
    const session = this.sessions.get(callId);
    if (!session) {
      ws.close(4004, 'No active session for this call');
      return;
    }

    session.fsWs = ws;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.handleFreeSWITCHAudio(callId, data as Buffer);
      } else {
        try {
          const event = JSON.parse(data.toString());
          this.handleFreeSWITCHEvent(callId, event);
        } catch {}
      }
    });

    ws.on('close', () => {
      const s = this.sessions.get(callId);
      if (s?.agentWs.readyState === WebSocket.OPEN) {
        this.sendToAgent(callId, { event: 'stream.ended', callId, reason: 'call_ended' });
      }
      this.endSession(callId, 'freeswitch_disconnected');
    });
  }

  endSession(callId: string, reason = 'normal'): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    if (session.agentWs.readyState === WebSocket.OPEN) {
      this.sendToAgent(callId, { event: 'stream.ended', callId, reason });
      session.agentWs.close(1000, 'Session ended');
    }
    if (session.fsWs?.readyState === WebSocket.OPEN) {
      session.fsWs.close(1000, 'Session ended');
    }

    // Emit session metrics
    this.emit('session.ended', {
      callId,
      streamId: session.streamId,
      accountId: session.accountId,
      durationMs: Date.now() - session.startedAt.getTime(),
      bytesReceived: session.bytesReceived,
      bytesSent: session.bytesSent,
      audioPacketsReceived: session.audioPacketsReceived,
      audioPacketsSent: session.audioPacketsSent,
      reason,
    });

    this.sessions.delete(callId);
  }

  private sendToAgent(callId: string, event: StreamToAgentEvent): void {
    const session = this.sessions.get(callId);
    if (!session || session.agentWs.readyState !== WebSocket.OPEN) return;
    session.agentWs.send(JSON.stringify(event));
  }

  private calculateEnergy(buffer: Buffer): number {
    // L16 PCM: 2 bytes per sample, little-endian signed 16-bit
    let sum = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }
    return Math.sqrt(sum / (buffer.length / 2));
  }

  getSession(callId: string): AudioStreamSession | undefined {
    return this.sessions.get(callId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getSessionMetrics(callId: string): Record<string, unknown> | null {
    const session = this.sessions.get(callId);
    if (!session) return null;
    return {
      streamId: session.streamId,
      callId: session.callId,
      durationMs: Date.now() - session.startedAt.getTime(),
      bytesReceived: session.bytesReceived,
      bytesSent: session.bytesSent,
      audioPacketsReceived: session.audioPacketsReceived,
      audioPacketsSent: session.audioPacketsSent,
      isRecording: session.isRecording,
      isSpeaking: session.isSpeaking,
    };
  }
}

export const audioStreamManager = new AudioStreamManager();
