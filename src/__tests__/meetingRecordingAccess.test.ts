const mockRecordingFindById = jest.fn();
const mockMemberExists = jest.fn();
const mockMemberFindOne = jest.fn();
const mockChunkDeleteMany = jest.fn();
const mockStorageRemove = jest.fn();
const mockStorageSize = jest.fn();
const mockStorageOpen = jest.fn();
jest.mock('../models/MeetingRecording.js', () => ({ __esModule: true, RecordingStatus: { COMPLETED: 'completed', INTERRUPTED: 'interrupted' }, default: { findById: mockRecordingFindById } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, WorkspaceRole: { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' }, default: { exists: mockMemberExists, findOne: mockMemberFindOne } }));
jest.mock('../models/MeetingRecordingChunk.js', () => ({ __esModule: true, default: { deleteMany: mockChunkDeleteMany } }));
jest.mock('../services/recordingStorage.js', () => ({ getRecordingStorage: () => ({ remove: mockStorageRemove, getSize: mockStorageSize, open: mockStorageOpen }) }));
jest.mock('../socket/index.js', () => ({ emitRecordingStatus: jest.fn(), emitRecordingConsentRequest: jest.fn() }));

import { createPlaybackTicket, deleteRecording, streamRecording } from '../controllers/meetingRecordingController.js';
import { verifyPlaybackToken } from '../services/recordingPlaybackToken.js';

function response() { const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn(), setHeader: jest.fn(), end: jest.fn(), destroy: jest.fn(), headersSent: false }; res.status.mockReturnValue(res); return res; }
const recordingId = '507f1f77bcf86cd799439011';
let priorSecret: string | undefined;
beforeEach(() => {
  jest.clearAllMocks(); priorSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'recording-test-secret-never-production';
  mockRecordingFindById.mockResolvedValue({ _id: recordingId, meetingId: 'meeting-1', workspaceId: 'workspace-1', hostId: 'host-1', status: 'completed', storageRef: `${recordingId}.webm`, mimeType: 'video/webm', fileSize: 100, durationMs: 5000, createdAt: new Date() });
  mockMemberExists.mockResolvedValue(true);
  mockMemberFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ role: 'member' }) }) });
  mockChunkDeleteMany.mockResolvedValue({}); mockStorageRemove.mockResolvedValue(undefined); mockStorageSize.mockResolvedValue(100);
});
afterEach(() => { if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret; });

describe('recording playback and deletion authorization', () => {
  it('does not issue playback links to a user outside the recording workspace', async () => {
    mockMemberExists.mockResolvedValue(false);
    const req: any = { params: { recordingId }, userId: 'outsider' }; const res = response();
    await createPlaybackTicket(req, res);
    expect(res.status).toHaveBeenCalledWith(403); expect(res.json.mock.calls[0][0]).not.toHaveProperty('streamUrl');
  });

  it('issues short-lived playback and download tickets only after workspace membership validation', async () => {
    const req: any = { params: { recordingId }, userId: 'member-1' }; const res = response();
    await createPlaybackTicket(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    const token = new URL(body.streamUrl, 'http://localhost').searchParams.get('ticket')!;
    expect(verifyPlaybackToken(token)).toMatchObject({ recordingId, userId: 'member-1', action: 'play' });
    expect(body.downloadUrl).toContain('ticket=');
  });

  it('rejects invalid or expired playback tickets before opening the private file', async () => {
    const req: any = { params: { recordingId }, query: { ticket: 'bad' } }; const res = response();
    await streamRecording(req, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(mockStorageOpen).not.toHaveBeenCalled();
  });

  it('allows host deletion but rejects ordinary workspace members', async () => {
    const req: any = { params: { recordingId }, userId: 'member-1' }; const denied = response();
    await deleteRecording(req, denied);
    expect(denied.status).toHaveBeenCalledWith(403); expect(mockStorageRemove).not.toHaveBeenCalled();
    req.userId = 'host-1'; const allowed = response();
    mockRecordingFindById.mockResolvedValue({ _id: recordingId, workspaceId: 'workspace-1', hostId: 'host-1', storageRef: `${recordingId}.webm`, deleteOne: jest.fn().mockResolvedValue(undefined) });
    await deleteRecording(req, allowed);
    expect(allowed.status).toHaveBeenCalledWith(204); expect(mockStorageRemove).toHaveBeenCalledWith(`${recordingId}.webm`, recordingId);
  });
});
