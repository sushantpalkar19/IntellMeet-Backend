import { Router } from 'express';
import {
  getWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceMembers,
  addMember,
  updateMemberRole,
  removeMember,
} from '../controllers/workspaceController.js';
import { authenticate } from '../middleware/auth.js';
import {
  requireWorkspaceMembership,
  requireAdmin,
  requireOwner,
} from '../middleware/workspaceAuth.js';

const router = Router();

/**
 * @route   GET /api/v1/workspaces
 * @desc    Get all workspaces for authenticated user
 * @access  Private
 */
router.get('/', authenticate, getWorkspaces);

/**
 * @route   POST /api/v1/workspaces
 * @desc    Create a new workspace
 * @access  Private
 */
router.post('/', authenticate, createWorkspace);

/**
 * @route   GET /api/v1/workspaces/:workspaceId
 * @desc    Get workspace details
 * @access  Private (member)
 */
router.get('/:workspaceId', authenticate, requireWorkspaceMembership, getWorkspace);

/**
 * @route   PUT /api/v1/workspaces/:workspaceId
 * @desc    Update workspace
 * @access  Private (admin/owner)
 */
router.put('/:workspaceId', authenticate, requireWorkspaceMembership, requireAdmin, updateWorkspace);

/**
 * @route   DELETE /api/v1/workspaces/:workspaceId
 * @desc    Delete workspace
 * @access  Private (owner only)
 */
router.delete('/:workspaceId', authenticate, requireWorkspaceMembership, requireOwner, deleteWorkspace);

/**
 * @route   GET /api/v1/workspaces/:workspaceId/members
 * @desc    Get workspace members
 * @access  Private (member)
 */
router.get('/:workspaceId/members', authenticate, requireWorkspaceMembership, getWorkspaceMembers);

/**
 * @route   POST /api/v1/workspaces/:workspaceId/members
 * @desc    Add member to workspace
 * @access  Private (admin/owner)
 */
router.post('/:workspaceId/members', authenticate, requireWorkspaceMembership, requireAdmin, addMember);

/**
 * @route   PUT /api/v1/workspaces/:workspaceId/members/:memberId
 * @desc    Update member role
 * @access  Private (owner only)
 */
router.put('/:workspaceId/members/:memberId', authenticate, requireWorkspaceMembership, requireOwner, updateMemberRole);

/**
 * @route   DELETE /api/v1/workspaces/:workspaceId/members/:memberId
 * @desc    Remove member from workspace
 * @access  Private (owner only)
 */
router.delete('/:workspaceId/members/:memberId', authenticate, requireWorkspaceMembership, requireOwner, removeMember);

export default router;
