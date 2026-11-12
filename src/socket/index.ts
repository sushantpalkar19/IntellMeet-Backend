import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyAccessToken, TokenPayload } from '../utils/jwt.js';
import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';
import MeetingMessage from '../models/MeetingMessage.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import User from '../models/User.js';
import { getTranscriptionState, resetTranscriptionState, setTranscriptionState, TranscriptionStatus } from '../services/transcriptionState.js';
import { getCurrentMeetingRecording, interruptHostRecording, pauseRecordingForLateParticipant, resumeRecordingIfConsentResolved } from '../services/meetingRecordingService.js';
import type { INotification } from '../models/Notification.js';

// In-memory state for tracking socket connections
// Note: For horizontal scaling, this would need to be replaced with Redis adapter
const userSocketMap = new Map<string, Set<string>>(); // userId -> Set of socketIds
const socketUserMap = new Map<string, string>(); // socketId -> userId
const screenSharingMap = new Map<string, string | null>(); // meetingId -> userId or null
const meetingMediaStateMap = new Map<string, Map<string, { audioEnabled: boolean; videoEnabled: boolean; user: { firstName: string; lastName: string; email: string } }>>();
let ioServer: SocketIOServer | null = null;

/** Broadcast the terminal meeting transition and evict sockets from that room. */
export function emitMeetingEnded(meetingId: string, endedAt: Date): void {
  if (!ioServer) return;
  const sharerId = screenSharingMap.get(meetingId);
  if (sharerId) ioServer.to(meetingId).emit('screenshare:stopped', { meetingId, userId: sharerId });
  ioServer.to(meetingId).emit('meeting:ended', { meetingId, endedAt });
  ioServer.in(meetingId).socketsLeave(meetingId);
  screenSharingMap.delete(meetingId);
  meetingMediaStateMap.delete(meetingId);
  resetTranscriptionState(meetingId);
}

function recordingStatusPayload(meetingId: string, recording: any) {
  return { meetingId, recording: { id: String(recording._id), status: recording.status, durationMs: recording.durationMs, fileSize: recording.fileSize, format: recording.format, mimeType: recording.mimeType, createdAt: recording.createdAt } };
}
export function emitRecordingStatus(meetingId: string, recording: any): void { ioServer?.to(meetingId).emit('recording:status', recordingStatusPayload(meetingId, recording)); }
export function emitRecordingConsentRequest(meetingId: string, recordingId: string, userIds: string[]): void {
  if (!ioServer) return;
  userIds.forEach((userId) => getUserSocketIds(userId).forEach((socketId) => ioServer?.to(socketId).emit('recording:consent-request', { meetingId, recordingId })));
}
export function emitUserNotification(userId: string, notification: Pick<INotification, '_id' | 'type' | 'title' | 'message' | 'meetingId' | 'createdAt' | 'readAt'>): void {
  if (!ioServer) return;
  const payload = { id: String(notification._id), type: notification.type, title: notification.title, message: notification.message, meetingId: String(notification.meetingId), createdAt: notification.createdAt, readAt: notification.readAt };
  getUserSocketIds(userId).forEach((socketId) => ioServer?.to(socketId).emit('notification:new', payload));
}

/** Send workspace board updates to every currently connected workspace member. */
export async function emitWorkspaceBoardEvent(workspaceId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  if (!ioServer) return;
  try {
    const members = await WorkspaceMember.find({ workspaceId }).select('userId').lean();
    members.forEach(({ userId }) => getUserSocketIds(String(userId)).forEach((socketId) => {
      ioServer?.to(socketId).emit(event, { workspaceId, ...payload });
    }));
  } catch (error) {
    console.error('Workspace board event delivery failed:', (error as Error).message);
  }
}

// Extend Socket interface to include user data
declare module 'socket.io' {
  interface Socket {
    userId?: string;
    userPayload?: TokenPayload;
  }
}

/**
 * Authenticate socket connection using JWT
 */
export async function authenticateSocket(socket: Socket, token: string): Promise<boolean> {
  try {
    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.userId).select('mustChangePassword');
    if (!user || user.mustChangePassword) return false;
    socket.userId = payload.userId;
    socket.userPayload = payload;
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Verify user has access to meeting via workspace membership
 */
export async function verifyMeetingAccess(userId: string, meetingId: string): Promise<boolean> {
  try {
    const meeting = await Meeting.findById(meetingId);
    if (!meeting) return false;

    const membership = await WorkspaceMember.findOne({
      workspaceId: meeting.workspaceId,
      userId,
    });

    return !!membership;
  } catch (error) {
    return false;
  }
}

/**
 * Track socket connection for user
 */
export function trackSocketConnection(userId: string, socketId: string): void {
  if (!userSocketMap.has(userId)) {
    userSocketMap.set(userId, new Set());
  }
  userSocketMap.get(userId)!.add(socketId);
  socketUserMap.set(socketId, userId);
}

/**
 * Remove socket connection for user
 */
export function removeSocketConnection(socketId: string): void {
  const userId = socketUserMap.get(socketId);
  if (userId) {
    const sockets = userSocketMap.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        userSocketMap.delete(userId);
      }
    }
    socketUserMap.delete(socketId);
  }
}

/**
 * Check if user has active connections
 */
export function hasActiveConnections(userId: string): boolean {
  const sockets = userSocketMap.get(userId);
  return sockets ? sockets.size > 0 : false;
}

/** Check identity only within the socket list returned for one meeting room. */
export function hasUserSocketInRoom(sockets: Pick<Socket, 'id' | 'data'>[], userId: string, excludeSocketId?: string): boolean {
  return sockets.some((roomSocket) => roomSocket.id !== excludeSocketId && roomSocket.data.userId === userId);
}

/**
 * Get all socket IDs for a user
 */
export function getUserSocketIds(userId: string): string[] {
  const sockets = userSocketMap.get(userId);
  return sockets ? Array.from(sockets) : [];
}

/**
 * Initialize Socket.IO server
 */
export function initializeSocketIO(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    },
  });
  ioServer = io;

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const authenticated = await authenticateSocket(socket, token);
      if (!authenticated) {
        return next(new Error('Invalid or expired token'));
      }

      // Track connection
      if (socket.userId) {
        socket.data.userId = socket.userId;
        trackSocketConnection(socket.userId, socket.id);
      }

      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`User ${userId} connected with socket ${socket.id}`);

    // Handle meeting join
    socket.on('meeting:join', async (data: { meetingId: string }) => {
      try {
        const { meetingId } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access
        const hasAccess = await verifyMeetingAccess(userId, meetingId);
        if (!hasAccess) {
          socket.emit('error', { message: 'You do not have access to this meeting' });
          return;
        }

        const meeting = await Meeting.findById(meetingId);
        if (!meeting) {
          socket.emit('error', { message: 'Meeting not found' });
          return;
        }

        // Check if meeting is joinable
        if (meeting.status === MeetingStatus.ENDED || meeting.status === MeetingStatus.CANCELLED) {
          socket.emit('error', { message: 'Cannot join a meeting that has ended or been cancelled' });
          return;
        }

        const isNewRoomSocket = !socket.rooms.has(meetingId);
        if (isNewRoomSocket) {
          const pausedRecording = await pauseRecordingForLateParticipant(meetingId, userId);
          if (pausedRecording) emitRecordingStatus(meetingId, pausedRecording);
        }

        // Avoid re-announcing the same user when another tab already occupies this meeting.
        const existingRoomSockets = await io.in(meetingId).fetchSockets();
        const alreadyPresentInRoom = hasUserSocketInRoom(existingRoomSockets, userId);

        // Join socket room
        socket.join(meetingId);

        // Synchronize an already active presenter with participants joining late.
        const activeSharerId = screenSharingMap.get(meetingId);
        if (activeSharerId) {
          const sharer = await User.findById(activeSharerId, 'firstName lastName email');
          if (sharer) socket.emit('screenshare:started', {
            meetingId,
            userId: activeSharerId,
            user: { firstName: sharer.firstName, lastName: sharer.lastName, email: sharer.email },
          });
        }

        const mediaStates = meetingMediaStateMap.get(meetingId);
        mediaStates?.forEach((state, participantUserId) => {
          if (participantUserId !== userId) {
            socket.emit('participant:media:state', { meetingId, userId: participantUserId, ...state });
          }
        });

        // Add or update participant
        let participant = await MeetingParticipant.findOne({
          meetingId,
          userId,
        });

        if (!participant) {
          participant = new MeetingParticipant({
            meetingId,
            userId,
            role: 'participant',
          });
          await participant.save();

          // Auto-start if creator joins scheduled meeting
          if (meeting.status === MeetingStatus.SCHEDULED && meeting.createdBy.toString() === userId) {
            meeting.status = MeetingStatus.LIVE;
            meeting.startedAt = new Date();
            await meeting.save();
            io.to(meetingId).emit('meeting:started', {
              meetingId,
              status: 'live',
              startedAt: meeting.startedAt,
            });
          }
        } else {
          // Clear leftAt if rejoining
          participant.leftAt = undefined;
          await participant.save();
        }

        // Get user info
        const user = await User.findById(userId, 'firstName lastName email');

        const existingParticipants = await MeetingParticipant.find({ meetingId, userId: { $ne: userId }, leftAt: null });
        for (const existingParticipant of existingParticipants) {
          const existingUser = await User.findById(existingParticipant.userId, 'firstName lastName email');
          if (existingUser) {
            socket.emit('participant:joined', {
              meetingId,
              userId: existingParticipant.userId.toString(),
              user: {
                firstName: existingUser.firstName,
                lastName: existingUser.lastName,
                email: existingUser.email,
              },
              joinedAt: existingParticipant.joinedAt,
            });
          }
        }

        // Broadcast only on a user's first active socket in this meeting.
        if (!alreadyPresentInRoom) {
          socket.to(meetingId).emit('participant:joined', {
            meetingId,
            userId,
            user: {
              firstName: user?.firstName,
              lastName: user?.lastName,
              email: user?.email,
            },
            joinedAt: participant.joinedAt,
          });
        }

        // Emit success to sender
        socket.emit('meeting:joined', {
          meetingId,
          meeting: {
            id: meeting._id,
            title: meeting.title,
            status: meeting.status,
            startedAt: meeting.startedAt,
          },
        });
        socket.emit('transcription:status', { meetingId, ...getTranscriptionState(meetingId) });
        const activeRecording = await getCurrentMeetingRecording(meetingId);
        if (activeRecording) {
          socket.emit('recording:status', recordingStatusPayload(meetingId, activeRecording));
          if (activeRecording.status === 'paused' && activeRecording.consent.some((entry) => String(entry.userId) === userId && entry.decision === 'pending')) socket.emit('recording:consent-request', { meetingId, recordingId: String(activeRecording._id) });
        }
      } catch (error) {
        console.error('Meeting join error:', error);
        socket.emit('error', { message: 'Failed to join meeting' });
      }
    });

    const controlTranscription = (status: TranscriptionStatus) => async (data: { meetingId: string; sessionId?: string }) => {
      try {
        const meetingId = String(data?.meetingId || '');
        if (!userId || !meetingId || !socket.rooms.has(meetingId)) {
          socket.emit('transcription:error', { meetingId, message: 'Join the meeting before controlling transcription' });
          return;
        }
        const meeting = await Meeting.findById(meetingId).select('createdBy workspaceId status');
        if (!meeting || meeting.createdBy.toString() !== userId || !(await verifyMeetingAccess(userId, meetingId))) {
          socket.emit('transcription:error', { meetingId, message: 'Only the meeting host can control transcription' });
          return;
        }
        const state = await setTranscriptionState(meetingId, userId, status, data.sessionId);
        io.to(meetingId).emit('transcription:status', { meetingId, ...state, changedBy: userId });
      } catch (error) {
        socket.emit('transcription:error', { meetingId: data?.meetingId, message: (error as Error).message || 'Could not update transcription' });
      }
    };
    socket.on('transcription:start', controlTranscription('running'));
    socket.on('transcription:resume', controlTranscription('running'));
    socket.on('transcription:pause', controlTranscription('paused'));
    socket.on('transcription:stop', controlTranscription('stopped'));

    // Handle meeting leave
    socket.on('meeting:leave', async (data: { meetingId: string }) => {
      try {
        const { meetingId } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Leave socket room
        socket.leave(meetingId);

        const remainingMeetingSockets = await io.in(meetingId).fetchSockets();
        const hasOtherConnections = remainingMeetingSockets.some((meetingSocket) => meetingSocket.data.userId === userId);

        if (!hasOtherConnections) {
          if (getTranscriptionState(meetingId).status !== 'stopped') {
            const meetingRecord = await Meeting.findById(meetingId).select('createdBy');
            if (meetingRecord?.createdBy.toString() === userId) {
              const transcriptionState = await setTranscriptionState(meetingId, userId, 'stopped');
              io.to(meetingId).emit('transcription:status', { meetingId, ...transcriptionState, changedBy: userId });
            }
          }
          // Update participant leftAt
          await MeetingParticipant.updateOne(
            { meetingId, userId, leftAt: null },
            { leftAt: new Date() }
          );
          if (String((await Meeting.findById(meetingId).select('createdBy'))?.createdBy) === userId) {
            const interrupted = await interruptHostRecording(meetingId, userId);
            if (interrupted) emitRecordingStatus(meetingId, interrupted);
          } else {
            const resumed = await resumeRecordingIfConsentResolved(meetingId);
            if (resumed) emitRecordingStatus(meetingId, resumed);
          }

          // Get user info
          const user = await User.findById(userId, 'firstName lastName email');

          // Broadcast participant left
          io.to(meetingId).emit('participant:left', {
            meetingId,
            userId,
            user: {
              firstName: user?.firstName,
              lastName: user?.lastName,
              email: user?.email,
            },
          });
          meetingMediaStateMap.get(meetingId)?.delete(userId);
          if (screenSharingMap.get(meetingId) === userId) {
            screenSharingMap.set(meetingId, null);
            io.to(meetingId).emit('screenshare:stopped', { meetingId, userId });
          }
        }

        socket.emit('meeting:left', { meetingId });
      } catch (error) {
        console.error('Meeting leave error:', error);
        socket.emit('error', { message: 'Failed to leave meeting' });
      }
    });

    // Handle WebRTC offer
    socket.on('webrtc:offer', async (data: { meetingId: string; targetUserId: string; offer: any }) => {
      try {
        const { meetingId, targetUserId, offer } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access for both users
        const senderHasAccess = await verifyMeetingAccess(userId, meetingId);
        const targetHasAccess = await verifyMeetingAccess(targetUserId, meetingId);

        if (!senderHasAccess || !targetHasAccess) {
          socket.emit('error', { message: 'Unauthorized signaling attempt' });
          return;
        }

        // Forward offer to target user's sockets
        const targetSocketIds = getUserSocketIds(targetUserId);
        targetSocketIds.forEach((socketId) => {
          io.to(socketId).emit('webrtc:offer', {
            meetingId,
            fromUserId: userId,
            offer,
          });
        });
      } catch (error) {
        console.error('WebRTC offer error:', error);
        socket.emit('error', { message: 'Failed to forward offer' });
      }
    });

    // Handle WebRTC answer
    socket.on('webrtc:answer', async (data: { meetingId: string; targetUserId: string; answer: any }) => {
      try {
        const { meetingId, targetUserId, answer } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access for both users
        const senderHasAccess = await verifyMeetingAccess(userId, meetingId);
        const targetHasAccess = await verifyMeetingAccess(targetUserId, meetingId);

        if (!senderHasAccess || !targetHasAccess) {
          socket.emit('error', { message: 'Unauthorized signaling attempt' });
          return;
        }

        // Forward answer to target user's sockets
        const targetSocketIds = getUserSocketIds(targetUserId);
        targetSocketIds.forEach((socketId) => {
          io.to(socketId).emit('webrtc:answer', {
            meetingId,
            fromUserId: userId,
            answer,
          });
        });
      } catch (error) {
        console.error('WebRTC answer error:', error);
        socket.emit('error', { message: 'Failed to forward answer' });
      }
    });

    // Handle ICE candidate
    socket.on('webrtc:ice-candidate', async (data: { meetingId: string; targetUserId: string; candidate: any }) => {
      try {
        const { meetingId, targetUserId, candidate } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access for both users
        const senderHasAccess = await verifyMeetingAccess(userId, meetingId);
        const targetHasAccess = await verifyMeetingAccess(targetUserId, meetingId);

        if (!senderHasAccess || !targetHasAccess) {
          socket.emit('error', { message: 'Unauthorized signaling attempt' });
          return;
        }

        // Forward candidate to target user's sockets
        const targetSocketIds = getUserSocketIds(targetUserId);
        targetSocketIds.forEach((socketId) => {
          io.to(socketId).emit('webrtc:ice-candidate', {
            meetingId,
            fromUserId: userId,
            candidate,
          });
        });
      } catch (error) {
        console.error('ICE candidate error:', error);
        socket.emit('error', { message: 'Failed to forward candidate' });
      }
    });

    // Handle WebRTC leave (peer connection cleanup)
    socket.on('webrtc:leave', async (data: { meetingId: string; targetUserId: string }) => {
      try {
        const { meetingId, targetUserId } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access for both users
        const senderHasAccess = await verifyMeetingAccess(userId, meetingId);
        const targetHasAccess = await verifyMeetingAccess(targetUserId, meetingId);

        if (!senderHasAccess || !targetHasAccess) {
          socket.emit('error', { message: 'Unauthorized signaling attempt' });
          return;
        }

        // Forward leave signal to target user's sockets
        const targetSocketIds = getUserSocketIds(targetUserId);
        targetSocketIds.forEach((socketId) => {
          io.to(socketId).emit('webrtc:leave', {
            meetingId,
            fromUserId: userId,
          });
        });
      } catch (error) {
        console.error('WebRTC leave error:', error);
        socket.emit('error', { message: 'Failed to forward leave signal' });
      }
    });

    // Handle media state update
    socket.on('media:state:update', async (data: { meetingId: string; audioEnabled: boolean; videoEnabled: boolean }) => {
      try {
        const { meetingId, audioEnabled, videoEnabled } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        if (!socket.rooms.has(meetingId) || typeof audioEnabled !== 'boolean' || typeof videoEnabled !== 'boolean') {
          socket.emit('error', { message: 'Invalid or unauthorized media state update' });
          return;
        }

        // Verify meeting access
        const hasAccess = await verifyMeetingAccess(userId, meetingId);
        if (!hasAccess) {
          socket.emit('error', { message: 'Unauthorized media state update' });
          return;
        }

        // Get user info
        const user = await User.findById(userId, 'firstName lastName email');
        if (!user) {
          socket.emit('error', { message: 'User not found' });
          return;
        }

        // Keep the last known state for participants who join later.
        if (!meetingMediaStateMap.has(meetingId)) meetingMediaStateMap.set(meetingId, new Map());
        meetingMediaStateMap.get(meetingId)!.set(userId, {
          audioEnabled,
          videoEnabled,
          user: { firstName: user.firstName, lastName: user.lastName, email: user.email },
        });

        // Broadcast to meeting room
        io.to(meetingId).emit('participant:media:state', {
          meetingId,
          userId,
          user: {
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
          },
          audioEnabled,
          videoEnabled,
        });
      } catch (error) {
        console.error('Media state update error:', error);
        socket.emit('error', { message: 'Failed to update media state' });
      }
    });

    // Handle chat message
    socket.on('chat:send', async (data: { meetingId: string; content: string }) => {
      try {
        const { meetingId, content } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Validate content
        if (!content || content.trim().length === 0) {
          socket.emit('error', { message: 'Message cannot be empty' });
          return;
        }

        if (content.length > 5000) {
          socket.emit('error', { message: 'Message too long (max 5000 characters)' });
          return;
        }

        // Verify meeting access
        const hasAccess = await verifyMeetingAccess(userId, meetingId);
        if (!hasAccess) {
          socket.emit('error', { message: 'You do not have access to this meeting' });
          return;
        }

        // Get user info
        const user = await User.findById(userId, 'firstName lastName email');
        if (!user) {
          socket.emit('error', { message: 'User not found' });
          return;
        }

        // Save message to database
        const message = new MeetingMessage({
          meetingId,
          userId,
          content: content.trim(),
          messageType: 'text',
        });
        await message.save();

        // Broadcast to meeting room
        io.to(meetingId).emit('chat:new', {
          meetingId,
          message: {
            id: message._id,
            userId,
            user: {
              firstName: user.firstName,
              lastName: user.lastName,
              email: user.email,
            },
            content: message.content,
            messageType: message.messageType,
            createdAt: message.createdAt,
          },
        });
      } catch (error) {
        console.error('Chat send error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Handle screen share start
    socket.on('screenshare:start', async (data: { meetingId: string }) => {
      try {
        const { meetingId } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access
        const hasAccess = await verifyMeetingAccess(userId, meetingId);
        if (!hasAccess) {
          socket.emit('screenshare:error', { message: 'You do not have access to this meeting' });
          return;
        }

        // Check if someone else is already sharing
        const currentSharer = screenSharingMap.get(meetingId);
        if (currentSharer && currentSharer !== userId) {
          socket.emit('screenshare:error', { message: 'Another participant is already sharing screen' });
          return;
        }

        // Set screen sharing state
        screenSharingMap.set(meetingId, userId);

        // Get user info
        const user = await User.findById(userId, 'firstName lastName email');

        // Broadcast to meeting room
        io.to(meetingId).emit('screenshare:started', {
          meetingId,
          userId,
          user: {
            firstName: user?.firstName,
            lastName: user?.lastName,
            email: user?.email,
          },
        });
      } catch (error) {
        console.error('Screen share start error:', error);
        socket.emit('screenshare:error', { message: 'Failed to start screen share' });
      }
    });

    // Handle screen share stop
    socket.on('screenshare:stop', async (data: { meetingId: string }) => {
      try {
        const { meetingId } = data;

        if (!userId) {
          socket.emit('error', { message: 'User not authenticated' });
          return;
        }

        // Verify meeting access
        const hasAccess = await verifyMeetingAccess(userId, meetingId);
        if (!hasAccess) {
          socket.emit('screenshare:error', { message: 'You do not have access to this meeting' });
          return;
        }

        // Check if this user is the current sharer
        const currentSharer = screenSharingMap.get(meetingId);
        if (currentSharer !== userId) {
          socket.emit('screenshare:error', { message: 'You are not currently sharing screen' });
          return;
        }

        // Clear screen sharing state
        screenSharingMap.set(meetingId, null);

        // Broadcast to meeting room
        io.to(meetingId).emit('screenshare:stopped', {
          meetingId,
          userId,
        });
      } catch (error) {
        console.error('Screen share stop error:', error);
        socket.emit('screenshare:error', { message: 'Failed to stop screen share' });
      }
    });

    // Handle disconnection
    socket.on('disconnecting', async () => {
      console.log(`User ${userId} disconnected socket ${socket.id}`);

      // Remove socket connection tracking
      removeSocketConnection(socket.id);

      if (userId) {
        // Get all rooms this socket was in and clean up participant state
        const rooms = socket.rooms;
        for (const room of rooms) {
          if (room !== socket.id) {
            // This is a meeting room
            try {
              // A user's sockets in other meetings must not keep this room's presence alive.
              const remainingRoomSockets = await io.in(room).fetchSockets();
              const userStillInRoom = hasUserSocketInRoom(remainingRoomSockets, userId, socket.id);
              if (userStillInRoom) continue;

              await MeetingParticipant.updateOne(
                { meetingId: room, userId, leftAt: null },
                { leftAt: new Date() }
              );

              if (String((await Meeting.findById(room).select('createdBy'))?.createdBy) === userId) {
                const interrupted = await interruptHostRecording(room, userId);
                if (interrupted) emitRecordingStatus(room, interrupted);
              } else {
                const resumed = await resumeRecordingIfConsentResolved(room);
                if (resumed) emitRecordingStatus(room, resumed);
              }

              // Check if user was screen sharing
              const currentSharer = screenSharingMap.get(room);
              if (currentSharer === userId) {
                screenSharingMap.set(room, null);
                io.to(room).emit('screenshare:stopped', {
                  meetingId: room,
                  userId,
                });
              }

              // Get user info
              const user = await User.findById(userId, 'firstName lastName email');

              // Broadcast participant left
              io.to(room).emit('participant:left', {
                meetingId: room,
                userId,
                user: {
                  firstName: user?.firstName,
                  lastName: user?.lastName,
                  email: user?.email,
                },
              });
              meetingMediaStateMap.get(room)?.delete(userId);
            } catch (error) {
              console.error('Disconnect cleanup error:', error);
            }
          }
        }
      }
    });
  });

  return io;
}

export { userSocketMap, socketUserMap, screenSharingMap };
