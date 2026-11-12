const mockFindMembership = jest.fn();
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { findOne: mockFindMembership }, WorkspaceRole: { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' } }));
import { requireAdmin, requireMember, requireWorkspaceMembership } from '../middleware/workspaceAuth.js';

function harness(role?: string) {
  const req: any = { userId: 'user-1', params: { workspaceId: 'workspace-1' }, body: {} };
  const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res);
  const next = jest.fn(); mockFindMembership.mockResolvedValue(role ? { role } : null);
  return { req, res, next };
}

describe('workspace board permissions', () => {
  beforeEach(() => jest.clearAllMocks());
  it('allows workspace members to read after membership lookup', async () => {
    const { req, res, next } = harness('member'); await requireWorkspaceMembership(req, res, next);
    expect(next).toHaveBeenCalledTimes(1); expect(req.workspaceId).toBe('workspace-1'); expect(res.status).not.toHaveBeenCalled();
  });
  it('allows owner/admin project management and rejects ordinary members', async () => {
    for (const role of ['owner', 'admin']) { const ctx = harness(role); await requireWorkspaceMembership(ctx.req, ctx.res, ctx.next); requireAdmin(ctx.req, ctx.res, ctx.next); expect(ctx.next).toHaveBeenCalledTimes(2); }
    const member = harness('member'); await requireWorkspaceMembership(member.req, member.res, member.next); requireAdmin(member.req, member.res, member.next); expect(member.res.status).toHaveBeenCalledWith(403);
  });
  it('allows members to manage tasks but rejects viewers and non-members', async () => {
    const member = harness('member'); await requireWorkspaceMembership(member.req, member.res, member.next); requireMember(member.req, member.res, member.next); expect(member.next).toHaveBeenCalledTimes(2);
    const viewer = harness('viewer'); await requireWorkspaceMembership(viewer.req, viewer.res, viewer.next); requireMember(viewer.req, viewer.res, viewer.next); expect(viewer.res.status).toHaveBeenCalledWith(403);
    const outsider = harness(); await requireWorkspaceMembership(outsider.req, outsider.res, outsider.next); expect(outsider.res.status).toHaveBeenCalledWith(403); expect(outsider.next).not.toHaveBeenCalled();
  });
});
