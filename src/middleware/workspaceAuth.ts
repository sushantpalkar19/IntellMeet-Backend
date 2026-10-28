import { Request, Response, NextFunction } from 'express';
import WorkspaceMember, { WorkspaceRole } from '../models/WorkspaceMember.js';

// Extend Express Request to include workspace context
declare global {
  namespace Express {
    interface Request {
      workspaceId?: string;
      userRole?: WorkspaceRole;
    }
  }
}

/**
 * Middleware to check if user is a member of the workspace
 */
export async function requireWorkspaceMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = req;
    const workspaceId = req.params.workspaceId || req.body.workspaceId;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

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

    req.workspaceId = workspaceId.toString();
    req.userRole = membership.role;

    next();
  } catch (error) {
    console.error('Workspace membership check error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify workspace membership',
    });
  }
}

/**
 * Middleware to check if user has at least the specified role
 * Role hierarchy: OWNER > ADMIN > MEMBER > VIEWER
 */
export function requireRole(minRole: WorkspaceRole) {
  const roleHierarchy: Record<WorkspaceRole, number> = {
    [WorkspaceRole.OWNER]: 4,
    [WorkspaceRole.ADMIN]: 3,
    [WorkspaceRole.MEMBER]: 2,
    [WorkspaceRole.VIEWER]: 1,
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.userRole;

    if (!userRole) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Role not found',
      });
      return;
    }

    if (roleHierarchy[userRole] < roleHierarchy[minRole]) {
      res.status(403).json({
        error: 'Forbidden',
        message: `You need at least ${minRole} role to perform this action`,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to check if user is workspace owner
 */
export const requireOwner = requireRole(WorkspaceRole.OWNER);

/**
 * Middleware to check if user is workspace admin or owner
 */
export const requireAdmin = requireRole(WorkspaceRole.ADMIN);

/**
 * Middleware to check if user is workspace member or higher
 */
export const requireMember = requireRole(WorkspaceRole.MEMBER);
