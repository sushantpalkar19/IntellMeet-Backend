import { Request, Response } from 'express';
import mongoose from 'mongoose';
import WorkspaceProject from '../models/WorkspaceProject.js';
import WorkspaceTask from '../models/WorkspaceTask.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import User from '../models/User.js';
import { createProjectSchema, createWorkspaceTaskSchema, updateProjectSchema, updateWorkspaceTaskSchema } from '../validators/workspaceTaskValidator.js';
import { emitWorkspaceBoardEvent } from '../socket/index.js';

const validId = (id: string) => mongoose.isValidObjectId(id);
const actorId = (req: Request) => req.userId!;
const projectFilter = (workspaceId: string, projectId: string) => ({ _id: projectId, workspaceId });

async function serializeTask(task: any) {
  const assignee = task.assigneeId ? await User.findById(task.assigneeId).select('firstName lastName email').lean() : null;
  return {
    id: String(task._id), workspaceId: String(task.workspaceId), projectId: String(task.projectId), title: task.title,
    description: task.description, assigneeId: task.assigneeId ? String(task.assigneeId) : null,
    assignee: assignee ? { id: String(task.assigneeId), firstName: assignee.firstName, lastName: assignee.lastName, email: assignee.email } : null,
    createdBy: String(task.createdBy), updatedBy: String(task.updatedBy), status: task.status, priority: task.priority,
    dueDate: task.dueDate, statusUpdatedAt: task.statusUpdatedAt, createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

function validationError(error: any, res: Response): boolean {
  if (error?.name !== 'ZodError') return false;
  res.status(400).json({ message: error.issues?.[0]?.message || 'Invalid request.' });
  return true;
}

export async function listProjects(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.workspaceId))) { res.status(400).json({ message: 'Invalid workspace ID.' }); return; }
  const projects = await WorkspaceProject.find({ workspaceId: String(req.params.workspaceId) }).sort({ updatedAt: -1 }).lean();
  res.json({ projects: projects.map((p) => ({ id: String(p._id), workspaceId: String(p.workspaceId), name: p.name, description: p.description, createdBy: String(p.createdBy), createdAt: p.createdAt, updatedAt: p.updatedAt })) });
}

export async function createProject(req: Request, res: Response): Promise<void> {
  try {
    const input = createProjectSchema.parse(req.body);
    const project = await WorkspaceProject.create({ ...input, workspaceId: req.workspaceId, createdBy: actorId(req) });
    const result = { id: String(project._id), workspaceId: String(project.workspaceId), name: project.name, description: project.description, createdBy: String(project.createdBy), createdAt: project.createdAt, updatedAt: project.updatedAt };
    void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:project:created', { project: result });
    res.status(201).json({ project: result });
  } catch (error) { if (validationError(error, res)) return; throw error; }
}

export async function updateProject(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId))) { res.status(400).json({ message: 'Invalid project ID.' }); return; }
  try {
    const input = updateProjectSchema.parse(req.body);
    const project = await WorkspaceProject.findOneAndUpdate(projectFilter(String(req.workspaceId), String(req.params.projectId)), input, { new: true, runValidators: true });
    if (!project) { res.status(404).json({ message: 'Project not found.' }); return; }
    const result = { id: String(project._id), workspaceId: String(project.workspaceId), name: project.name, description: project.description, createdBy: String(project.createdBy), createdAt: project.createdAt, updatedAt: project.updatedAt };
    void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:project:updated', { project: result });
    res.json({ project: result });
  } catch (error) { if (validationError(error, res)) return; throw error; }
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId))) { res.status(400).json({ message: 'Invalid project ID.' }); return; }
  const project = await WorkspaceProject.findOneAndDelete(projectFilter(String(req.workspaceId), String(req.params.projectId)));
  if (!project) { res.status(404).json({ message: 'Project not found.' }); return; }
  await WorkspaceTask.deleteMany({ workspaceId: req.workspaceId, projectId: project._id });
  void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:project:deleted', { projectId: String(project._id) });
  res.status(204).send();
}

export async function listProjectTasks(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId))) { res.status(400).json({ message: 'Invalid project ID.' }); return; }
  const exists = await WorkspaceProject.exists(projectFilter(String(req.workspaceId), String(req.params.projectId)));
  if (!exists) { res.status(404).json({ message: 'Project not found.' }); return; }
  const tasks = await WorkspaceTask.find({ workspaceId: req.workspaceId, projectId: String(req.params.projectId) }).sort({ updatedAt: -1 });
  res.json({ tasks: await Promise.all(tasks.map(serializeTask)) });
}

async function validateAssignee(workspaceId: string, assigneeId: string | null | undefined): Promise<boolean> {
  return !assigneeId || Boolean(await WorkspaceMember.exists({ workspaceId, userId: assigneeId }));
}

export async function createProjectTask(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId))) { res.status(400).json({ message: 'Invalid project ID.' }); return; }
  try {
    const input = createWorkspaceTaskSchema.parse(req.body);
    const project = await WorkspaceProject.exists(projectFilter(String(req.workspaceId), String(req.params.projectId)));
    if (!project) { res.status(404).json({ message: 'Project not found.' }); return; }
    if (!(await validateAssignee(String(req.workspaceId), input.assigneeId))) { res.status(400).json({ message: 'Assignee must be a member of this workspace.' }); return; }
    const task = await WorkspaceTask.create({ ...input, dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null, workspaceId: req.workspaceId, projectId: String(req.params.projectId), createdBy: actorId(req), updatedBy: actorId(req) });
    const result = await serializeTask(task);
    void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:task:created', { task: result });
    res.status(201).json({ task: result });
  } catch (error) { if (validationError(error, res)) return; throw error; }
}

export async function updateProjectTask(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId)) || !validId(String(req.params.taskId))) { res.status(400).json({ message: 'Invalid project or task ID.' }); return; }
  try {
    const input = updateWorkspaceTaskSchema.parse(req.body);
    if (input.assigneeId !== undefined && !(await validateAssignee(String(req.workspaceId), input.assigneeId))) { res.status(400).json({ message: 'Assignee must be a member of this workspace.' }); return; }
    const task = await WorkspaceTask.findOne({ _id: String(req.params.taskId), projectId: String(req.params.projectId), workspaceId: req.workspaceId });
    if (!task) { res.status(404).json({ message: 'Task not found.' }); return; }
    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.assigneeId !== undefined) task.assigneeId = input.assigneeId ? new mongoose.Types.ObjectId(input.assigneeId) : null;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.dueDate !== undefined) task.dueDate = input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null;
    if (input.status !== undefined && input.status !== task.status) { task.status = input.status; task.statusUpdatedAt = new Date(); }
    task.updatedBy = new mongoose.Types.ObjectId(actorId(req));
    await task.save();
    const result = await serializeTask(task);
    void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:task:updated', { task: result });
    res.json({ task: result });
  } catch (error) { if (validationError(error, res)) return; throw error; }
}

export async function deleteProjectTask(req: Request, res: Response): Promise<void> {
  if (!validId(String(req.params.projectId)) || !validId(String(req.params.taskId))) { res.status(400).json({ message: 'Invalid project or task ID.' }); return; }
  const task = await WorkspaceTask.findOneAndDelete({ _id: String(req.params.taskId), projectId: String(req.params.projectId), workspaceId: req.workspaceId });
  if (!task) { res.status(404).json({ message: 'Task not found.' }); return; }
  void emitWorkspaceBoardEvent(String(req.workspaceId), 'workspace:task:deleted', { taskId: String(task._id) });
  res.status(204).send();
}
