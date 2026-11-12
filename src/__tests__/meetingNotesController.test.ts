const mockItemFindOne = jest.fn();
const mockItemFindOneAndUpdate = jest.fn();
const mockMemberExists = jest.fn();
const mockTranscriptFindOne = jest.fn();
jest.mock('../models/MeetingActionItem.js', () => ({ __esModule: true, ActionItemStatus: { PENDING: 'PENDING', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED' }, default: { findOne: mockItemFindOne, findOneAndUpdate: mockItemFindOneAndUpdate } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { exists: mockMemberExists } }));
jest.mock('../models/MeetingTranscript.js', () => ({ __esModule: true, default: { findOne: mockTranscriptFindOne } }));
import { updateActionItem, updateActionItemStatus } from '../controllers/meetingNotesController.js';

function response() { const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn() }; res.status.mockReturnValue(res); return res; }
beforeEach(() => { jest.clearAllMocks(); });
describe('meeting action item editing', () => {
  it('requires the assignee to be a workspace member and authenticated transcript speaker', async () => {
    mockItemFindOne.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', save: jest.fn() }); mockMemberExists.mockResolvedValue(true);
    mockTranscriptFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const req: any = { params: { actionItemId: '507f1f77bcf86cd799439011' }, meetingId: 'meeting-1', workspaceId: 'workspace-1', body: { assigneeId: '507f1f77bcf86cd799439012' } };
    const res = response(); await updateActionItem(req, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(res.json.mock.calls[0][0].message).toContain('authenticated speaker attribution');
  });

  it('rejects invalid status and never auto-completes an action item', async () => {
    const req: any = { params: { actionItemId: '507f1f77bcf86cd799439011' }, meetingId: 'meeting-1', body: { status: 'DONE' } };
    const res = response(); await updateActionItemStatus(req, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(mockItemFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('stores a valid explicit status update', async () => {
    mockItemFindOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', meetingId: 'meeting-1', taskDescription: 'Review risks', status: 'COMPLETED', toObject() { return this; } });
    const req: any = { params: { actionItemId: '507f1f77bcf86cd799439011' }, meetingId: 'meeting-1', body: { status: 'COMPLETED' } };
    const res = response(); await updateActionItemStatus(req, res);
    expect(mockItemFindOneAndUpdate).toHaveBeenCalledWith({ _id: req.params.actionItemId, meetingId: 'meeting-1' }, { $set: { status: 'COMPLETED' } }, { new: true, runValidators: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
