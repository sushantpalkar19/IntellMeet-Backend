const mockProjectExists = jest.fn();
const mockTaskCreate = jest.fn();
const mockTaskFindOne = jest.fn();
const mockMemberExists = jest.fn();
const mockEmitBoardEvent = jest.fn();
jest.mock('../models/WorkspaceProject.js', () => ({ __esModule: true, default: { exists: mockProjectExists } }));
jest.mock('../models/WorkspaceTask.js', () => ({ __esModule: true, WorkspaceTaskStatus: { TODO: 'TODO', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE' }, WorkspaceTaskPriority: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', URGENT: 'URGENT' }, default: { create: mockTaskCreate, findOne: mockTaskFindOne } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { exists: mockMemberExists } }));
jest.mock('../models/User.js', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../socket/index.js', () => ({ emitWorkspaceBoardEvent: mockEmitBoardEvent }));

import { createProjectTask, updateProjectTask } from '../controllers/workspaceProjectController.js';

function response() { const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn() }; res.status.mockReturnValue(res); return res; }
const taskId = '507f1f77bcf86cd799439011';
const projectId = '507f1f77bcf86cd799439012';
const userId = '507f1f77bcf86cd799439013';
beforeEach(() => { jest.clearAllMocks(); mockProjectExists.mockResolvedValue({ _id: projectId }); mockMemberExists.mockResolvedValue(true); });

describe('workspace project tasks', () => {
  it('creates workspace-scoped tasks using authenticated identity and emits task creation', async () => {
    const createdAt = new Date();
    mockTaskCreate.mockResolvedValue({ _id: taskId, workspaceId: 'workspace-1', projectId, title: 'Prepare demo', description: '', assigneeId: null, createdBy: userId, updatedBy: userId, status: 'TODO', priority: 'HIGH', dueDate: null, statusUpdatedAt: createdAt, createdAt, updatedAt: createdAt });
    const req: any = { workspaceId: 'workspace-1', userId, params: { projectId }, body: { title: 'Prepare demo', priority: 'HIGH' } };
    const res = response(); await createProjectTask(req, res);
    expect(mockTaskCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1', projectId, createdBy: userId, updatedBy: userId, title: 'Prepare demo', status: 'TODO', priority: 'HIGH' }));
    expect(res.status).toHaveBeenCalledWith(201); expect(mockEmitBoardEvent).toHaveBeenCalledWith('workspace-1', 'workspace:task:created', expect.objectContaining({ task: expect.objectContaining({ title: 'Prepare demo' }) }));
  });

  it('rejects assignment to a user outside the workspace', async () => {
    mockMemberExists.mockResolvedValue(false);
    const req: any = { workspaceId: 'workspace-1', userId, params: { projectId }, body: { title: 'Prepare demo', assigneeId: taskId } };
    const res = response(); await createProjectTask(req, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(mockTaskCreate).not.toHaveBeenCalled();
  });

  it('rejects invalid due dates rather than allowing a database cast failure', async () => {
    const req: any = { workspaceId: 'workspace-1', userId, params: { projectId }, body: { title: 'Prepare demo', dueDate: '2026-99-99' } };
    const res = response(); await createProjectTask(req, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(mockTaskCreate).not.toHaveBeenCalled();
  });

  it('records the time of a real status transition and prevents cross-project task edits', async () => {
    const task: any = { _id: taskId, workspaceId: 'workspace-1', projectId, status: 'TODO', priority: 'MEDIUM', createdBy: userId, updatedBy: userId, save: jest.fn().mockResolvedValue(undefined) };
    mockTaskFindOne.mockResolvedValue(task);
    const req: any = { workspaceId: 'workspace-1', userId, params: { projectId, taskId }, body: { status: 'IN_PROGRESS' } };
    const res = response(); await updateProjectTask(req, res);
    expect(mockTaskFindOne).toHaveBeenCalledWith({ _id: taskId, projectId, workspaceId: 'workspace-1' });
    expect(task.status).toBe('IN_PROGRESS'); expect(task.statusUpdatedAt).toBeInstanceOf(Date); expect(task.updatedBy.toString()).toBe(userId); expect(task.save).toHaveBeenCalled();
  });
});
