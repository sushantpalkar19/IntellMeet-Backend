const mockMeetingFindById = jest.fn();
const mockParticipantExists = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockMeetingFindById } }));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { exists: mockParticipantExists } }));

import { getTranscriptionState, setTranscriptionState } from '../services/transcriptionState.js';

beforeEach(() => {
  jest.clearAllMocks();
  mockMeetingFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ createdBy: { toString: () => 'host-1' }, status: 'live' }) });
  mockParticipantExists.mockResolvedValue({ _id: 'participant' });
});

describe('host controlled transcription state', () => {
  it('allows only the actual meeting host to start transcription', async () => {
    await expect(setTranscriptionState('state-meeting-host-test', 'host-1', 'running', 'valid-session-id-123')).resolves.toMatchObject({ status: 'running', sessionId: 'valid-session-id-123' });
    await expect(setTranscriptionState('state-meeting-host-test', 'different-user', 'paused')).rejects.toThrow('Only the meeting host');
  });

  it('keeps state available to participants reconnecting to the meeting', async () => {
    const started = await setTranscriptionState('state-meeting-reconnect-test', 'host-1', 'running', 'valid-session-id-456');
    await expect(setTranscriptionState('state-meeting-reconnect-test', 'host-1', 'paused')).resolves.toMatchObject({ status: 'paused', sessionId: started.sessionId });
    expect(getTranscriptionState('state-meeting-reconnect-test').status).toBe('paused');
  });

  it('rejects a host who is not actively joined and rejects invalid session identifiers', async () => {
    mockParticipantExists.mockResolvedValue(null);
    await expect(setTranscriptionState('state-meeting-inactive-test', 'host-1', 'running', 'valid-session-id-789')).rejects.toThrow('active meeting participant');
    await expect(setTranscriptionState('state-meeting-invalid-test', 'host-1', 'running', 'bad')).rejects.toThrow('Invalid transcription session');
  });
});
