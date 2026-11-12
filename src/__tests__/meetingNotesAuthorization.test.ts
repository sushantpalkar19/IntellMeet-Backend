const mockFindMeeting = jest.fn();
const mockFindMembership = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockFindMeeting } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { findOne: mockFindMembership }, WorkspaceRole: { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' } }));
import { requireMeetingAccess } from '../middleware/meetingAuth.js';

function harness(userId?: string) {
  const req: any = { userId, params: { meetingId: 'meeting-1' }, body: {} };
  const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res);
  const next = jest.fn(); return { req, res, next };
}
beforeEach(() => { jest.clearAllMocks(); mockFindMeeting.mockResolvedValue({ workspaceId: 'workspace-1' }); });

describe('meeting notes workspace authorization', () => {
  it('rejects unauthenticated requests before allowing summary or action-item access', async () => {
    const { req, res, next } = harness(); await requireMeetingAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled(); expect(mockFindMeeting).not.toHaveBeenCalled();
  });
  it('rejects authenticated users without meeting workspace membership', async () => {
    mockFindMembership.mockResolvedValue(null);
    const { req, res, next } = harness('outsider'); await requireMeetingAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
  it('allows an authenticated workspace member and attaches server-loaded workspace authorization context', async () => {
    mockFindMembership.mockResolvedValue({ role: 'member' });
    const { req, res, next } = harness('member-1'); await requireMeetingAccess(req, res, next);
    expect(req.workspaceId).toBe('workspace-1'); expect(req.meetingId).toBe('meeting-1'); expect(next).toHaveBeenCalledTimes(1); expect(res.status).not.toHaveBeenCalled();
  });
});
