const mockMembershipFind = jest.fn();
const mockMeetingAggregate = jest.fn(); const mockMeetingCount = jest.fn(); const mockMeetingFind = jest.fn();
const mockParticipantAggregate = jest.fn(); const mockTaskAggregate = jest.fn();
const mockSummaryCount = jest.fn(); const mockSummaryDistinct = jest.fn(); const mockTranscriptAggregate = jest.fn(); const mockTranscriptDistinct = jest.fn();
const mockActionCount = jest.fn(); const mockRecordingCount = jest.fn(); const mockRecordingDistinct = jest.fn();
const mockSummaryAggregate = jest.fn(); const mockRecordingAggregate = jest.fn();
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { find: mockMembershipFind } }));
jest.mock('../models/Meeting.js', () => ({ __esModule: true, MeetingStatus: { SCHEDULED: 'scheduled', LIVE: 'live' }, default: { aggregate: mockMeetingAggregate, countDocuments: mockMeetingCount, find: mockMeetingFind, collection: { name: 'meetings' } } }));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { aggregate: mockParticipantAggregate } }));
jest.mock('../models/WorkspaceTask.js', () => ({ __esModule: true, default: { aggregate: mockTaskAggregate } }));
jest.mock('../models/MeetingSummary.js', () => ({ __esModule: true, default: { aggregate: mockSummaryAggregate, countDocuments: mockSummaryCount, distinct: mockSummaryDistinct } }));
jest.mock('../models/MeetingTranscript.js', () => ({ __esModule: true, default: { aggregate: mockTranscriptAggregate, distinct: mockTranscriptDistinct } }));
jest.mock('../models/MeetingActionItem.js', () => ({ __esModule: true, default: { countDocuments: mockActionCount } }));
jest.mock('../models/MeetingRecording.js', () => ({ __esModule: true, default: { aggregate: mockRecordingAggregate, countDocuments: mockRecordingCount, distinct: mockRecordingDistinct } }));
jest.mock('../models/Workspace.js', () => ({ __esModule: true, default: { find: jest.fn(), collection: { name: 'workspaces' } } }));

import { analyticsOverview, aiAnalytics, meetingAnalytics, taskAnalytics } from '../controllers/analyticsController.js';

function response() { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; }
const workspaceId = '507f1f77bcf86cd799439011';
function req(query: Record<string, string> = {}) { return { userId: '507f1f77bcf86cd799439012', query } as any; }
function allowedMembership() { mockMembershipFind.mockReturnValue({ select: () => ({ lean: async () => [{ workspaceId }] }) }); }
beforeEach(() => { jest.clearAllMocks(); allowedMembership(); });

describe('analytics access and aggregations', () => {
  it('returns current live/upcoming counts and generated summaries using the Analytics overview', async () => {
    mockMeetingAggregate.mockResolvedValueOnce([{ _id: 'ended', count: 1 }]).mockResolvedValueOnce([]);
    mockParticipantAggregate.mockResolvedValue([]); mockTaskAggregate.mockResolvedValue([]);
    mockMeetingCount.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    mockSummaryAggregate.mockResolvedValueOnce([{ count: 2 }]);
    const res = response(); await analyticsOverview(req(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ meetings: expect.objectContaining({ live: 1, upcoming: 3 }), ai: { summariesGenerated: 2 } }));
    const [liveFilter, scheduledFilter] = mockMeetingCount.mock.calls.map(([filter]) => filter);
    expect(liveFilter).toMatchObject({ workspaceId: { $in: expect.any(Array) }, status: 'live' });
    expect(scheduledFilter).toMatchObject({ status: 'scheduled', scheduledAt: { $gt: expect.any(Date) }, $or: expect.any(Array) });
    expect(mockSummaryAggregate.mock.calls[0][0][0].$match).toMatchObject({ workspaceId: { $in: expect.any(Array) }, generationStatus: 'completed' });
    expect(mockSummaryAggregate.mock.calls[0][0][1]).toEqual({ $group: { _id: '$meetingId' } });
  });

  it('rejects an unauthorized workspace filter before querying analytics records', async () => {
    mockMembershipFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const res = response(); await analyticsOverview(req({ workspaceId }), res);
    expect(res.status).toHaveBeenCalledWith(403); expect(mockMeetingAggregate).not.toHaveBeenCalled();
  });

  it('rejects invalid or reversed date ranges', async () => {
    const invalid = response(); await analyticsOverview(req({ from: '2026-02-30' }), invalid); expect(invalid.status).toHaveBeenCalledWith(400);
    const reversed = response(); await analyticsOverview(req({ from: '2026-11-10', to: '2026-11-01' }), reversed); expect(reversed.status).toHaveBeenCalledWith(400);
    expect(mockMeetingAggregate).not.toHaveBeenCalled();
  });

  it('returns actual empty aggregates safely and applies an inclusive UTC date filter', async () => {
    mockMeetingAggregate.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockParticipantAggregate.mockResolvedValue([]); mockSummaryAggregate.mockResolvedValue([]); mockTaskAggregate.mockResolvedValue([]); mockMeetingCount.mockResolvedValue(0);
    const res = response(); await analyticsOverview(req({ from: '2026-11-01', to: '2026-11-12', workspaceId }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ meetings: expect.objectContaining({ total: 0, live: 0, upcoming: 0, totalDurationMs: 0, averageDurationMs: null }), attendanceRecords: 0, ai: { summariesGenerated: 0 }, tasks: expect.objectContaining({ total: 0 }) }));
    expect(mockMeetingAggregate.mock.calls[0][0][0].$match.createdAt).toEqual({ $gte: new Date('2026-11-01T00:00:00.000Z'), $lte: new Date('2026-11-12T23:59:59.999Z') });
  });

  it('calculates task completion percentage and keeps statuses distinct from AI action items', async () => {
    mockTaskAggregate.mockResolvedValueOnce([{ _id: 'DONE', count: 3 }, { _id: 'TODO', count: 1 }]).mockResolvedValueOnce([{ _id: 'HIGH', count: 2 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = response(); await taskAnalytics(req(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 4, completed: 3, todo: 1, inProgress: 0, completionPercent: 75, priorities: { HIGH: 2 } }));
  });

  it('groups meeting activity and joins attendance records to meetings in authorized workspaces', async () => {
    mockMeetingAggregate.mockResolvedValueOnce([{ _id: '2026-11-12', count: 2 }]).mockResolvedValueOnce([{ _id: 'ended', count: 2 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockParticipantAggregate.mockResolvedValueOnce([{ _id: '2026-11-12', attendanceRecords: 3, meetingCount: 2 }]);
    const res = response(); await meetingAnalytics(req({ workspaceId, from: '2026-11-01', to: '2026-11-12', groupBy: 'week' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'week', activity: [{ _id: '2026-11-12', count: 2 }], attendance: [{ _id: '2026-11-12', attendanceRecords: 3, meetingCount: 2 }] }));
    const attendancePipeline = mockParticipantAggregate.mock.calls[0][0];
    expect(attendancePipeline.some((stage: any) => stage.$lookup?.from === 'meetings')).toBe(true);
    expect(attendancePipeline.some((stage: any) => stage.$match?.['meeting.workspaceId']?.$in?.length === 1)).toBe(true);
  });

  it('reports persisted transcript, summary, action-item and recording metrics', async () => {
    mockTranscriptAggregate.mockResolvedValue([{ meetings: 1, segments: 9 }]);
    mockSummaryAggregate.mockResolvedValue([{ count: 2 }]); mockRecordingAggregate.mockResolvedValue([{ meetings: 1, recordings: 1 }]); mockActionCount.mockResolvedValue(4);
    const res = response(); await aiAnalytics(req(), res);
    expect(res.json).toHaveBeenCalledWith({ transcriptMeetings: 1, transcriptSegments: 9, summariesGenerated: 2, meetingsWithSummaries: 2, actionItems: 4, recordings: 1, meetingsWithRecordings: 1 });
  });
});
