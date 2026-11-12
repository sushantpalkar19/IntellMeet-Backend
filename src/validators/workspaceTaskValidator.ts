import { z } from 'zod';
import { WorkspaceTaskPriority, WorkspaceTaskStatus } from '../models/WorkspaceTask.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'A valid ID is required.');
const dueDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Due date must be a valid calendar date.'), z.literal(''), z.null()]).optional();
export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).optional().default('') });
export const updateProjectSchema = createProjectSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide project fields to update.');
export const createWorkspaceTaskSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).optional().default(''),
  assigneeId: objectId.nullable().optional().default(null),
  status: z.nativeEnum(WorkspaceTaskStatus).optional().default(WorkspaceTaskStatus.TODO),
  priority: z.nativeEnum(WorkspaceTaskPriority).optional().default(WorkspaceTaskPriority.MEDIUM), dueDate,
});
export const updateWorkspaceTaskSchema = createWorkspaceTaskSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide task fields to update.');
