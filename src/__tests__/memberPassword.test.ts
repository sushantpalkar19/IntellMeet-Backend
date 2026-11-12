import { addMemberSchema } from '../validators/workspaceValidator.js';
import { changePasswordSchema } from '../validators/authValidator.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import User from '../models/User.js';
import WorkspaceMember from '../models/WorkspaceMember.js';

describe('member temporary password security', () => {
  it('validates email, password policy, and workspace role', () => {
    const valid = { email: 'New.User@example.com', password: 'Temporary9Pass', role: 'member' };
    expect(addMemberSchema.safeParse(valid).success).toBe(true);
    expect(addMemberSchema.safeParse({ ...valid, email: 'bad-email' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ ...valid, password: 'weak' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ ...valid, role: 'superuser' }).success).toBe(false);
  });

  it('hashes temporary passwords and marks the new account for forced change', async () => {
    const temporaryPassword = 'Temporary9Pass';
    const passwordHash = await hashPassword(temporaryPassword);
    const newUser = new User({ email: 'member@example.com', passwordHash, firstName: 'member', lastName: 'Member', mustChangePassword: true });
    expect(passwordHash).not.toBe(temporaryPassword);
    expect(await comparePassword(temporaryPassword, passwordHash)).toBe(true);
    expect(newUser.mustChangePassword).toBe(true);
    expect(User.schema.path('passwordHash').options.select).toBe(false);
  });

  it('keeps membership uniqueness enforced by the database index', () => {
    const uniqueMembershipIndex = WorkspaceMember.schema.indexes().find(([keys, options]) =>
      keys.workspaceId === 1 && keys.userId === 1 && options.unique === true,
    );
    expect(uniqueMembershipIndex).toBeDefined();
  });

  it('validates new passwords for the first-login password change', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: 'Temporary9Pass', newPassword: 'Updated8Password' }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ currentPassword: 'Temporary9Pass', newPassword: 'weak' }).success).toBe(false);
  });
});
