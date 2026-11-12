import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingParticipant, { ParticipantRole } from '../models/MeetingParticipant.js';
import MeetingMessage from '../models/MeetingMessage.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { emitMeetingEnded, emitRecordingStatus } from '../socket/index.js';
import { interruptHostRecording } from '../services/meetingRecordingService.js';
import { createMeetingSchema } from '../validators/meetingValidator.js';

/**
 * Create a new meeting
 */
export async function createMeeting(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    const parsed = createMeetingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Bad Request', message: parsed.error.issues[0]?.message || 'Meeting details are invalid' });
      return;
    }
    const { workspaceId, title, description, scheduledAt } = parsed.data;
    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
      res.status(400).json({ error: 'Bad Request', message: 'Meeting start must be in the future.' });
      return;
    }

    // Verify user is a member of the workspace
    const membership = await WorkspaceMember.findOne({
      workspaceId,
      userId,
    });

    if (!membership) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You are not a member of this workspace',
      });
      return;
    }

    // Create meeting
    const codes = await generateMeetingCodes();
    const meeting = new Meeting({
      workspaceId,
      title,
      description,
      createdBy: userId,
      status: MeetingStatus.SCHEDULED,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
      ...codes,
    });

    await meeting.save();

    res.status(201).json({
      message: 'Meeting created successfully',
      meeting: {
        id: meeting._id,
        workspaceId: meeting.workspaceId,
        title: meeting.title,
        description: meeting.description,
        createdBy: meeting.createdBy,
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        createdAt: meeting.createdAt,
        meetingCode: meeting.meetingCode,
      },
    });
  } catch (error) {
    console.error('Create meeting error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create meeting',
    });
  }
}

async function generateMeetingCodes(): Promise<{ meetingCode: string; joinCode: string; invitationId: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const meetingCode = `IM-${randomBytes(4).toString('hex').toUpperCase()}`;
    const joinCode = randomBytes(4).toString('hex').toUpperCase();
    const invitationId = randomBytes(24).toString('base64url');
    const exists = await Meeting.exists({ $or: [{ meetingCode }, { joinCode }, { invitationId }] });
    if (!exists) return { meetingCode, joinCode, invitationId };
  }
  throw new Error('Could not generate a unique meeting invitation');
}

export async function getMeetingInvitation(req: Request, res: Response): Promise<void> {
  try {
    const meetingId = req.params.meetingId;
    const userId = req.userId;
    if (!meetingId || !userId) {
      res.status(401).json({ error: 'Unauthorized', message: 'User not authenticated' });
      return;
    }
    const meeting = await Meeting.findById(meetingId).select('+invitationId');
    if (!meeting) {
      res.status(404).json({ error: 'Not Found', message: 'Meeting not found' });
      return;
    }
    if (meeting.createdBy.toString() !== userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the meeting host can view invitation details' });
      return;
    }
    res.status(200).json({ meetingId: meeting.meetingCode, joinCode: meeting.joinCode, invitationId: meeting.invitationId });
  } catch (error) {
    console.error('Get meeting invitation error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to get meeting invitation' });
  }
}

export async function joinMeetingByCode(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req;
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', message: 'User not authenticated' });
      return;
    }
    if (!/^(IM-[A-F0-9]{8}|[A-F0-9]{8}|[A-Za-z0-9_-]{32})$/.test(code)) {
      res.status(404).json({ error: 'Not Found', message: 'Meeting code is invalid or unavailable' });
      return;
    }
    const query = /^[A-Za-z0-9_-]{32}$/.test(code)
      ? { invitationId: code }
      : { $or: [{ meetingCode: code }, { joinCode: code }] };
    const meeting = await Meeting.findOne(query);
    if (!meeting || meeting.status === MeetingStatus.ENDED || meeting.status === MeetingStatus.CANCELLED) {
      res.status(404).json({ error: 'Not Found', message: 'Meeting code is invalid or unavailable' });
      return;
    }
    const membership = await WorkspaceMember.findOne({ workspaceId: meeting.workspaceId, userId });
    if (!membership) {
      res.status(404).json({ error: 'Not Found', message: 'Meeting code is invalid or unavailable' });
      return;
    }
    res.status(200).json({ meetingId: meeting._id, meetingCode: meeting.meetingCode });
  } catch (error) {
    console.error('Join meeting by code error:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to join meeting' });
  }
}

/**
 * List meetings for workspaces the user can access
 */
export async function listMeetings(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req;
    const { workspaceId, status } = req.query;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    // Get all workspace memberships for the user
    const memberships = await WorkspaceMember.find({ userId });
    const workspaceIds = memberships.map((m) => m.workspaceId.toString());

    // Build query
    const query: any = { workspaceId: { $in: workspaceIds } };

    // Filter by specific workspace if provided
    if (workspaceId) {
      if (!workspaceIds.includes(workspaceId as string)) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to this workspace',
        });
        return;
      }
      query.workspaceId = new mongoose.Types.ObjectId(workspaceId as string);
    }

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    const meetings = await Meeting.find(query)
      .sort({ createdAt: -1 })
      .populate('createdBy', 'firstName lastName email');

    res.status(200).json({
      meetings: meetings.map((meeting) => ({
        id: meeting._id,
        workspaceId: meeting.workspaceId,
        title: meeting.title,
        description: meeting.description,
        createdBy: (meeting.createdBy as any)._id.toString(),
        createdByUser: {
          id: (meeting.createdBy as any)._id,
          firstName: (meeting.createdBy as any).firstName,
          lastName: (meeting.createdBy as any).lastName,
          email: (meeting.createdBy as any).email,
        },
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
      })),
    });
  } catch (error) {
    console.error('List meetings error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list meetings',
    });
  }
}

/**
 * Get meeting details
 */
export async function getMeeting(req: Request, res: Response): Promise<void> {
  try {
    const { meetingId } = req;

    if (!meetingId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Meeting ID is required',
      });
      return;
    }

    const meeting = await Meeting.findById(meetingId).populate('createdBy', 'firstName lastName email');

    if (!meeting) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Meeting not found',
      });
      return;
    }

    res.status(200).json({
      meeting: {
        id: meeting._id,
        workspaceId: meeting.workspaceId,
        title: meeting.title,
        description: meeting.description,
        createdBy: (meeting.createdBy as any)._id.toString(),
        createdByUser: {
          id: (meeting.createdBy as any)._id,
          firstName: (meeting.createdBy as any).firstName,
          lastName: (meeting.createdBy as any).lastName,
          email: (meeting.createdBy as any).email,
        },
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get meeting error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get meeting',
    });
  }
}

/**
 * Join a meeting
 */
export async function joinMeeting(req: Request, res: Response): Promise<void> {
  try {
    const { userId, meetingId } = req;

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

    // Check if meeting is joinable
    if (meeting.status === MeetingStatus.ENDED || meeting.status === MeetingStatus.CANCELLED) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot join a meeting that has ended or been cancelled',
      });
      return;
    }

    // Check if user is already a participant
    let participant = await MeetingParticipant.findOne({
      meetingId,
      userId,
    });

    if (participant) {
      // User already joined, return existing participant
      res.status(200).json({
        message: 'Already joined meeting',
        participant: {
          id: participant._id,
          meetingId: participant.meetingId,
          userId: participant.userId,
          role: participant.role,
          joinedAt: participant.joinedAt,
        },
      });
      return;
    }

    // Add user as participant
    participant = new MeetingParticipant({
      meetingId,
      userId,
      role: ParticipantRole.PARTICIPANT,
    });

    await participant.save();

    // If meeting is SCHEDULED and this is the creator, start it
    if (meeting.status === MeetingStatus.SCHEDULED && meeting.createdBy.toString() === userId) {
      meeting.status = MeetingStatus.LIVE;
      meeting.startedAt = new Date();
      await meeting.save();
    }

    res.status(200).json({
      message: 'Joined meeting successfully',
      participant: {
        id: participant._id,
        meetingId: participant.meetingId,
        userId: participant.userId,
        role: participant.role,
        joinedAt: participant.joinedAt,
      },
      meeting: {
        id: meeting._id,
        status: meeting.status,
        startedAt: meeting.startedAt,
      },
    });
  } catch (error) {
    console.error('Join meeting error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to join meeting',
    });
  }
}

/**
 * Get meeting messages
 */
export async function getMeetingMessages(req: Request, res: Response): Promise<void> {
  try {
    const { meetingId } = req;
    const { page = '1', limit = '50' } = req.query;

    if (!meetingId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Meeting ID is required',
      });
      return;
    }

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    const meeting = await Meeting.findById(meetingId);
    if (!meeting) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Meeting not found',
      });
      return;
    }

    const messages = await MeetingMessage.find({ meetingId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('userId', 'firstName lastName email');

    const total = await MeetingMessage.countDocuments({ meetingId });

    res.status(200).json({
      messages: messages.map((msg) => ({
        id: msg._id,
        meetingId: msg.meetingId,
        userId: msg.userId,
        user: {
          id: (msg.userId as any)._id,
          firstName: (msg.userId as any).firstName,
          lastName: (msg.userId as any).lastName,
          email: (msg.userId as any).email,
        },
        content: msg.content,
        messageType: msg.messageType,
        createdAt: msg.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Get meeting messages error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get meeting messages',
    });
  }
}

/**
 * End a meeting
 */
export async function endMeeting(req: Request, res: Response): Promise<void> {
  try {
    const { meetingId } = req;

    if (!meetingId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Meeting ID is required',
      });
      return;
    }

    let meeting = await Meeting.findById(meetingId);

    if (!meeting) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Meeting not found',
      });
      return;
    }

    if (meeting.status === MeetingStatus.CANCELLED) {
      res.status(400).json({ error: 'Bad Request', message: 'A cancelled meeting cannot be ended' });
      return;
    }

    if (meeting.status !== MeetingStatus.ENDED) {
      const endedAt = new Date();
      const transitionedMeeting = await Meeting.findOneAndUpdate(
        { _id: meetingId, status: { $in: [MeetingStatus.SCHEDULED, MeetingStatus.LIVE] } },
        { $set: { status: MeetingStatus.ENDED, endedAt } },
        { new: true },
      );
      if (transitionedMeeting) meeting = transitionedMeeting;
      else {
        meeting = await Meeting.findById(meetingId);
        if (!meeting || meeting.status !== MeetingStatus.ENDED) {
          res.status(409).json({ error: 'Conflict', message: 'Meeting status changed before it could be ended' });
          return;
        }
      }
    }

    // Mark all participants as left
    await MeetingParticipant.updateMany(
      { meetingId, leftAt: null },
      { leftAt: new Date() }
    );
    const interruptedRecording = await interruptHostRecording(meetingId, String(meeting.createdBy));
    if (interruptedRecording) emitRecordingStatus(meetingId, interruptedRecording);
    emitMeetingEnded(meetingId, meeting.endedAt ?? new Date());

    res.status(200).json({
      message: 'Meeting ended successfully',
      meeting: {
        id: meeting._id,
        status: meeting.status,
        endedAt: meeting.endedAt,
      },
    });
  } catch (error) {
    console.error('End meeting error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to end meeting',
    });
  }
}
