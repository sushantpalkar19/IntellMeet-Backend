import { Request, Response, NextFunction } from 'express';
import Meeting from '../models/Meeting.js';
import WorkspaceMember, { WorkspaceRole } from '../models/WorkspaceMember.js';

// Extend Express Request to include meeting context
declare global {
  namespace Express {
    interface Request {
      meetingId?: string;
    }
  }
}

/**
 * Middleware to check if user has access to a meeting via workspace membership
 */
export async function requireMeetingAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = req;
    const meetingId = req.params.meetingId || req.body.meetingId;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    if (!meetingId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Meeting ID is required',
      });
      return;
    }

    const meeting = await Meeting.findById(meetingId);

    if (!meeting) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Meeting not found',
      });
      return;
    }

    // Check if user is a member of the workspace
    const membership = await WorkspaceMember.findOne({
      workspaceId: meeting.workspaceId,
      userId,
    });

    if (!membership) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have access to this meeting',
      });
      return;
    }

    // Attach meeting context to request
    req.workspaceId = meeting.workspaceId.toString();
    req.userRole = membership.role;
    req.meetingId = meetingId.toString();

    next();
  } catch (error) {
    console.error('Meeting access check error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify meeting access',
    });
  }
}

/**
 * Middleware to check if user is the meeting creator or workspace admin/owner
 */
export async function requireMeetingHostOrAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, userRole } = req;
    const meetingId = req.params.meetingId || req.body.meetingId;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    if (!meetingId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Meeting ID is required',
      });
      return;
    }

    const meeting = await Meeting.findById(meetingId);

    if (!meeting) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Meeting not found',
      });
      return;
    }

    // Check if user is the creator or has admin/owner role
    const isCreator = meeting.createdBy.toString() === userId;
    const isAdmin = userRole === WorkspaceRole.ADMIN || userRole === WorkspaceRole.OWNER;

    if (!isCreator && !isAdmin) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the meeting creator or workspace admin/owner can perform this action',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Meeting host check error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify meeting host permissions',
    });
  }
}

/** Only the account that created this meeting may end it for everyone. */
export async function requireMeetingHost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const meetingId = req.meetingId || req.params.meetingId;
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized', message: 'User not authenticated' });
      return;
    }
    if (!meetingId) {
      res.status(400).json({ error: 'Bad Request', message: 'Meeting ID is required' });
      return;
    }
    const meeting = await Meeting.findById(meetingId).select('createdBy');
    if (!meeting) {
      res.status(404).json({ error: 'Not Found', message: 'Meeting not found' });
      return;
    }
    if (meeting.createdBy.toString() !== req.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the meeting host can end this meeting' });
      return;
    }
    next();
  } catch (error) {
    console.error('Meeting host check error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify meeting host permissions' });
  }
}
