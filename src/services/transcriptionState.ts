import Meeting from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';

export type TranscriptionStatus = 'stopped' | 'running' | 'paused';
export interface MeetingTranscriptionState { status: TranscriptionStatus; sessionId: string | null; startedAt: string | null; updatedAt: string; }
const states = new Map<string, MeetingTranscriptionState>();

export function getTranscriptionState(meetingId: string): MeetingTranscriptionState {
  return states.get(meetingId) ?? { status: 'stopped', sessionId: null, startedAt: null, updatedAt: new Date().toISOString() };
}

export async function setTranscriptionState(meetingId: string, userId: string, status: TranscriptionStatus, sessionId?: string): Promise<MeetingTranscriptionState> {
  if (status === 'running' && sessionId && !/^[A-Za-z0-9_-]{16,80}$/.test(sessionId)) throw new Error('Invalid transcription session');
  const meeting = await Meeting.findById(meetingId).select('createdBy status');
  if (!meeting) throw new Error('Meeting not found');
  if (meeting.createdBy.toString() !== userId) throw new Error('Only the meeting host can control transcription');
  if (meeting.status === 'ended' || meeting.status === 'cancelled') throw new Error('Meeting is not active');
  const current = getTranscriptionState(meetingId);
  if (status === 'running' || status === 'paused') {
    const participant = await MeetingParticipant.exists({ meetingId, userId, leftAt: null });
    if (!participant) throw new Error('Host must be an active meeting participant');
  }
  const next: MeetingTranscriptionState = {
    status,
    // Keep the completed session identifier briefly so independently finalized chunks
    // already in flight can still be accepted after pause/stop reaches the room.
    sessionId: status === 'running' && sessionId ? sessionId : current.sessionId,
    startedAt: status === 'running' && sessionId ? new Date().toISOString() : current.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  states.set(meetingId, next);
  return next;
}

export function resetTranscriptionState(meetingId: string): void { states.delete(meetingId); }
