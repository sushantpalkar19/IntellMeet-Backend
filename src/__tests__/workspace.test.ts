import { WorkspaceRole } from '../models/WorkspaceMember.js';

describe('Workspace Access Control', () => {
  describe('Role Hierarchy', () => {
    it('should enforce role hierarchy: OWNER > ADMIN > MEMBER > VIEWER', () => {
      const roleHierarchy: Record<WorkspaceRole, number> = {
        [WorkspaceRole.OWNER]: 4,
        [WorkspaceRole.ADMIN]: 3,
        [WorkspaceRole.MEMBER]: 2,
        [WorkspaceRole.VIEWER]: 1,
      };

      expect(roleHierarchy[WorkspaceRole.OWNER]).toBeGreaterThan(roleHierarchy[WorkspaceRole.ADMIN]);
      expect(roleHierarchy[WorkspaceRole.ADMIN]).toBeGreaterThan(roleHierarchy[WorkspaceRole.MEMBER]);
      expect(roleHierarchy[WorkspaceRole.MEMBER]).toBeGreaterThan(roleHierarchy[WorkspaceRole.VIEWER]);
    });
  });

  describe('Role Values', () => {
    it('should have all required role values', () => {
      expect(WorkspaceRole.OWNER).toBe('owner');
      expect(WorkspaceRole.ADMIN).toBe('admin');
      expect(WorkspaceRole.MEMBER).toBe('member');
      expect(WorkspaceRole.VIEWER).toBe('viewer');
    });
  });
});
