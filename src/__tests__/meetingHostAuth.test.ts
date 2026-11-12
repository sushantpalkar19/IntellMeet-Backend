const mockFindMeeting = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockFindMeeting } }));

import { requireMeetingHost } from '../middleware/meetingAuth.js';

function harness() {
  const req: any = { userId: 'host-1', params: { meetingId: 'meeting-1' }, userRole: 'owner' };
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return { req, res, next: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('actual meeting host authorization', () => {
  it('allows only the meeting creator to end the meeting', async () => {
    mockFindMeeting.mockReturnValue({ select: jest.fn().mockResolvedValue({ createdBy: { toString: () => 'host-1' } }) });
    const { req, res, next } = harness();
    await requireMeetingHost(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a workspace owner/admin who is not the actual host', async () => {
    mockFindMeeting.mockReturnValue({ select: jest.fn().mockResolvedValue({ createdBy: { toString: () => 'different-user' } }) });
    const { req, res, next } = harness();
    await requireMeetingHost(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
