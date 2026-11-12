import { z } from 'zod';
import { MeetingStatus } from '../models/Meeting.js';

export const createMeetingSchema = z.object({
  workspaceId: z.string().regex(/^[a-f\d]{24}$/i, 'Workspace ID is invalid'),
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be less than 200 characters')
    .trim(),
  description: z.string().max(1000, 'Description must be less than 1000 characters').trim().optional().default(''),
  scheduledAt: z.string().datetime().optional(),
});

export const updateMeetingSchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be less than 200 characters')
    .trim()
    .optional(),
  description: z
    .string()
    .min(1, 'Description is required')
    .max(1000, 'Description must be less than 1000 characters')
    .trim()
    .optional(),
  scheduledAt: z.string().datetime().optional(),
});

export const listMeetingsSchema = z.object({
  workspaceId: z.string().min(1, 'Workspace ID is required').optional(),
  status: z.enum(MeetingStatus).optional(),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export type ListMeetingsInput = z.infer<typeof listMeetingsSchema>;
