import { z } from 'zod';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Dates must use a valid YYYY-MM-DD calendar date.');

export const analyticsQuerySchema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  workspaceId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid workspace ID.').optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional().default('day'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
