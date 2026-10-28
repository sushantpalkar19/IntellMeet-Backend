import { Request, Response } from 'express';
import Workspace from '../models/Workspace.js';
import WorkspaceMember, { WorkspaceRole } from '../models/WorkspaceMember.js';
import User from '../models/User.js';

/**
 * Get all workspaces for the authenticated user
 */
export async function getWorkspaces(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    // Find all workspace memberships for the user
    const memberships = await WorkspaceMember.find({ userId })
      .populate('workspaceId')
      .sort({ joinedAt: -1 });

    const workspaces = memberships.map((membership) => {
      const workspace = membership.workspaceId as any;
      return {
        id: workspace._id,
        name: workspace.name,
        description: workspace.description,
        ownerId: workspace.ownerId,
        role: membership.role,
        joinedAt: membership.joinedAt,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      };
    });

    res.status(200).json({
      workspaces,
    });
  } catch (error) {
    console.error('Get workspaces error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get workspaces',
    });
  }
}

/**
 * Create a new workspace
 */
export async function createWorkspace(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req;
    const { name, description } = req.body;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    // Create workspace
    const workspace = new Workspace({
      name,
      description,
      ownerId: userId,
    });

    await workspace.save();

    // Add creator as owner
    const membership = new WorkspaceMember({
      workspaceId: workspace._id,
      userId,
      role: WorkspaceRole.OWNER,
    });

    await membership.save();

    res.status(201).json({
      message: 'Workspace created successfully',
      workspace: {
        id: workspace._id,
        name: workspace.name,
        description: workspace.description,
        ownerId: workspace.ownerId,
        role: WorkspaceRole.OWNER,
        createdAt: workspace.createdAt,
      },
    });
  } catch (error) {
    console.error('Create workspace error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create workspace',
    });
  }
}

/**
 * Get workspace details
 */
export async function getWorkspace(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole } = req;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    const workspace = await Workspace.findById(workspaceId);

    if (!workspace) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Workspace not found',
      });
      return;
    }

    res.status(200).json({
      workspace: {
        id: workspace._id,
        name: workspace.name,
        description: workspace.description,
        ownerId: workspace.ownerId,
        role: userRole,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get workspace error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get workspace',
    });
  }
}

/**
 * Update workspace
 */
export async function updateWorkspace(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole } = req;
    const { name, description } = req.body;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    const workspace = await Workspace.findById(workspaceId);

    if (!workspace) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Workspace not found',
      });
      return;
    }

    // Only owner and admin can update
    if (userRole !== WorkspaceRole.OWNER && userRole !== WorkspaceRole.ADMIN) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only owners and admins can update workspace',
      });
      return;
    }

    // Update fields
    if (name !== undefined) workspace.name = name;
    if (description !== undefined) workspace.description = description;

    await workspace.save();

    res.status(200).json({
      message: 'Workspace updated successfully',
      workspace: {
        id: workspace._id,
        name: workspace.name,
        description: workspace.description,
        ownerId: workspace.ownerId,
        role: userRole,
        updatedAt: workspace.updatedAt,
      },
    });
  } catch (error) {
    console.error('Update workspace error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update workspace',
    });
  }
}

/**
 * Delete workspace
 */
export async function deleteWorkspace(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole } = req;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    const workspace = await Workspace.findById(workspaceId);

    if (!workspace) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Workspace not found',
      });
      return;
    }

    // Only owner can delete
    if (userRole !== WorkspaceRole.OWNER) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only workspace owner can delete workspace',
      });
      return;
    }

    // Delete all memberships
    await WorkspaceMember.deleteMany({ workspaceId });

    // Delete workspace
    await Workspace.findByIdAndDelete(workspaceId);

    res.status(200).json({
      message: 'Workspace deleted successfully',
    });
  } catch (error) {
    console.error('Delete workspace error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete workspace',
    });
  }
}

/**
 * Get workspace members
 */
export async function getWorkspaceMembers(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId } = req;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    const memberships = await WorkspaceMember.find({ workspaceId })
      .populate('userId')
      .sort({ joinedAt: 1 });

    const members = memberships.map((membership) => {
      const user = membership.userId as any;
      return {
        id: membership._id,
        userId: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership.role,
        joinedAt: membership.joinedAt,
      };
    });

    res.status(200).json({
      members,
    });
  } catch (error) {
    console.error('Get workspace members error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get workspace members',
    });
  }
}

/**
 * Add member to workspace
 */
export async function addMember(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole } = req;
    const { email, role = WorkspaceRole.MEMBER } = req.body;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    // Only owner and admin can add members
    if (userRole !== WorkspaceRole.OWNER && userRole !== WorkspaceRole.ADMIN) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only owners and admins can add members',
      });
      return;
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

    // Check if user is already a member
    const existingMember = await WorkspaceMember.findOne({
      workspaceId,
      userId: user._id,
    });

    if (existingMember) {
      res.status(409).json({
        error: 'Conflict',
        message: 'User is already a member of this workspace',
      });
      return;
    }

    // Cannot add owner role
    if (role === WorkspaceRole.OWNER) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot add member as owner. Use ownership transfer instead.',
      });
      return;
    }

    // Add member
    const membership = new WorkspaceMember({
      workspaceId,
      userId: user._id,
      role,
    });

    await membership.save();

    res.status(201).json({
      message: 'Member added successfully',
      member: {
        id: membership._id,
        userId: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership.role,
        joinedAt: membership.joinedAt,
      },
    });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to add member',
    });
  }
}

/**
 * Update member role
 */
export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole: currentUserRole } = req;
    const { memberId, role } = req.body;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    // Only owner can change roles
    if (currentUserRole !== WorkspaceRole.OWNER) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only workspace owner can change member roles',
      });
      return;
    }

    const membership = await WorkspaceMember.findById(memberId);

    if (!membership) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Membership not found',
      });
      return;
    }

    // Verify membership belongs to this workspace
    if (membership.workspaceId.toString() !== workspaceId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Membership does not belong to this workspace',
      });
      return;
    }

    // Cannot change the last owner
    if (membership.role === WorkspaceRole.OWNER) {
      const ownerCount = await WorkspaceMember.countDocuments({
        workspaceId,
        role: WorkspaceRole.OWNER,
      });

      if (ownerCount <= 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot change the role of the last owner. Transfer ownership first.',
        });
        return;
      }
    }

    // Cannot set role to owner
    if (role === WorkspaceRole.OWNER) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot set role to owner. Use ownership transfer instead.',
      });
      return;
    }

    // Update role
    membership.role = role;
    await membership.save();

    const user = await User.findById(membership.userId);

    res.status(200).json({
      message: 'Member role updated successfully',
      member: {
        id: membership._id,
        userId: user?._id,
        email: user?.email,
        firstName: user?.firstName,
        lastName: user?.lastName,
        role: membership.role,
      },
    });
  } catch (error) {
    console.error('Update member role error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update member role',
    });
  }
}

/**
 * Remove member from workspace
 */
export async function removeMember(req: Request, res: Response): Promise<void> {
  try {
    const { workspaceId, userRole: currentUserRole } = req;
    const { memberId } = req.params;

    if (!workspaceId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Workspace ID is required',
      });
      return;
    }

    const membership = await WorkspaceMember.findById(memberId);

    if (!membership) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Membership not found',
      });
      return;
    }

    // Verify membership belongs to this workspace
    if (membership.workspaceId.toString() !== workspaceId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Membership does not belong to this workspace',
      });
      return;
    }

    // Only owner can remove members
    if (currentUserRole !== WorkspaceRole.OWNER) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only workspace owner can remove members',
      });
      return;
    }

    // Cannot remove the last owner
    if (membership.role === WorkspaceRole.OWNER) {
      const ownerCount = await WorkspaceMember.countDocuments({
        workspaceId,
        role: WorkspaceRole.OWNER,
      });

      if (ownerCount <= 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot remove the last owner. Transfer ownership first.',
        });
        return;
      }
    }

    await WorkspaceMember.findByIdAndDelete(memberId);

    res.status(200).json({
      message: 'Member removed successfully',
    });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to remove member',
    });
  }
}
