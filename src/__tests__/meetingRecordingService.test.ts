const mockMeetingFind = jest.fn();
const mockParticipantFind = jest.fn();
const mockParticipantExists = jest.fn();
const mockRecordingCreate = jest.fn();
const mockRecordingFindOne = jest.fn();
const mockRecordingFindOneAndUpdate = jest.fn();
const mockRecordingUpdateOne = jest.fn();
const mockChunkFindOne = jest.fn();
const mockChunkFind = jest.fn();
const mockChunkCreate = jest.fn();
const mockChunkDeleteOne = jest.fn();
const mockWriteChunk = jest.fn();
const mockRemoveChunk = jest.fn();
const mockAssemble = jest.fn();
const mockStorageRemove = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockMeetingFind }, MeetingStatus: { LIVE: 'live' } }));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { find: mockParticipantFind, exists: mockParticipantExists } }));
jest.mock('../models/MeetingRecording.js', () => ({ __esModule: true, RecordingStatus: { AWAITING_CONSENT: 'awaiting_consent', RECORDING: 'recording', PAUSED: 'paused', PROCESSING: 'processing', COMPLETED: 'completed', INTERRUPTED: 'interrupted', CONSENT_DENIED: 'consent_denied', FAILED: 'failed' }, default: { create: mockRecordingCreate, findOne: mockRecordingFindOne, findOneAndUpdate: mockRecordingFindOneAndUpdate, updateOne: mockRecordingUpdateOne } }));
jest.mock('../models/MeetingRecordingChunk.js', () => ({ __esModule: true, default: { findOne: mockChunkFindOne, find: mockChunkFind, create: mockChunkCreate, deleteOne: mockChunkDeleteOne } }));
jest.mock('../services/recordingStorage.js', () => ({ getRecordingStorage: () => ({ writeChunk: mockWriteChunk, removeChunk: mockRemoveChunk, assemble: mockAssemble, remove: mockStorageRemove }) }));

import { changeMeetingRecording, createMeetingRecording, respondToRecordingConsent, uploadRecordingChunk } from '../services/meetingRecordingService.js';

let recording: any;
beforeEach(() => {
  jest.clearAllMocks();
  mockMeetingFind.mockResolvedValue({ _id: 'meeting-1', createdBy: 'host-1', workspaceId: 'workspace-1', status: 'live' });
  mockParticipantFind.mockReturnValue({ select: () => ({ lean: async () => [{ userId: 'host-1' }, { userId: 'member-1' }] }) });
  mockParticipantExists.mockResolvedValue(true);
  recording = { _id: '507f1f77bcf86cd799439011', meetingId: 'meeting-1', workspaceId: 'workspace-1', hostId: 'host-1', status: 'recording', mimeType: 'video/webm', activeSlot: 'meeting-1', durationMs: 0, fileSize: 0, consent: [{ userId: 'host-1', decision: 'consented' }, { userId: 'member-1', decision: 'consented' }], save: jest.fn().mockResolvedValue(undefined) };
  mockRecordingCreate.mockImplementation(async (value) => Object.assign(recording, value));
  mockRecordingFindOne.mockResolvedValue(recording);
  mockRecordingFindOneAndUpdate.mockResolvedValue(recording);
  mockRecordingUpdateOne.mockResolvedValue({});
  mockChunkFindOne.mockReturnValue({ lean: async () => null });
  mockChunkFind.mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => [{ sequence: 0 }, { sequence: 1 }] }) }) });
  mockChunkCreate.mockResolvedValue({}); mockChunkDeleteOne.mockResolvedValue({});
  mockWriteChunk.mockResolvedValue(undefined); mockRemoveChunk.mockResolvedValue(undefined); mockAssemble.mockResolvedValue({ storageRef: `${recording._id}.webm`, fileSize: 4096, format: 'webm/opus' }); mockStorageRemove.mockResolvedValue(undefined);
});

describe('meeting recording lifecycle and upload service', () => {
  it('allows only the actual host to start and requires other active participants to consent', async () => {
    await expect(createMeetingRecording('meeting-1', 'member-1', 'video/webm')).rejects.toMatchObject({ status: 403 });
    expect(mockRecordingCreate).not.toHaveBeenCalled();
    const started = await createMeetingRecording('meeting-1', 'host-1', 'video/webm');
    expect(started.status).toBe('awaiting_consent');
    expect(mockRecordingCreate).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-1', activeSlot: 'meeting-1', consent: expect.arrayContaining([expect.objectContaining({ userId: 'member-1', decision: 'pending' })]) }));
  });

  it('switches to recording only after active participants accept consent', async () => {
    recording.status = 'awaiting_consent'; recording.startedAt = undefined;
    recording.consent = [{ userId: 'host-1', decision: 'consented' }, { userId: 'member-1', decision: 'pending' }];
    await respondToRecordingConsent('meeting-1', String(recording._id), 'member-1', true);
    expect(recording.status).toBe('recording'); expect(recording.consent[1].decision).toBe('consented');
  });

  it('persists out-of-order chunks but assembles them in sequence order on stop', async () => {
    const first = Buffer.from('sequence one'); const second = Buffer.from('sequence zero');
    await uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 1, 1000, 2000, 'video/webm', first);
    await uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/webm', second);
    mockChunkFind.mockReturnValue({ sort: (sort: any) => ({ select: () => ({ lean: async () => sort.sequence === 1 ? [{ sequence: 0 }, { sequence: 1 }] : [] }) }) });
    const stopped = await changeMeetingRecording('meeting-1', String(recording._id), 'host-1', 'stop');
    expect(mockWriteChunk.mock.calls.map((call) => call[1])).toEqual([1, 0]);
    expect(mockAssemble).toHaveBeenCalledWith(String(recording._id), 'video/webm', [0, 1]);
    expect(stopped.status).toBe('completed'); expect(stopped.storageRef).toBe(`${recording._id}.webm`);
  });

  it('makes same-content chunk retries idempotent and rejects conflicting sequence reuse', async () => {
    const bytes = Buffer.from('stable chunk');
    await uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/webm', bytes);
    mockChunkFindOne.mockReturnValue({ lean: async () => ({ sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') }) });
    await expect(uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/webm', bytes)).resolves.toMatchObject({ duplicate: true });
    mockChunkFindOne.mockReturnValue({ lean: async () => ({ sha256: '0'.repeat(64) }) });
    await expect(uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/webm', bytes)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects non-host uploads, mismatched MIME types and oversized chunks', async () => {
    const bytes = Buffer.from('small');
    await expect(uploadRecordingChunk('meeting-1', String(recording._id), 'member-1', 0, 0, 1000, 'video/webm', bytes)).rejects.toMatchObject({ status: 403 });
    await expect(uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/mp4', bytes)).rejects.toMatchObject({ status: 413 });
    await expect(uploadRecordingChunk('meeting-1', String(recording._id), 'host-1', 0, 0, 1000, 'video/webm', Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
    expect(mockWriteChunk).not.toHaveBeenCalled();
  });

  it('marks a completed stop as failed when private storage assembly fails', async () => {
    mockAssemble.mockRejectedValue(new Error('disk unavailable'));
    const result = await changeMeetingRecording('meeting-1', String(recording._id), 'host-1', 'stop');
    expect(result.status).toBe('failed');
    expect(mockRecordingUpdateOne).toHaveBeenCalledWith({ _id: recording._id }, { $unset: { activeSlot: 1 } });
  });
});
