const mockUsers = new Map<string, Record<string, any>>();
const mockMemberships = new Map<string, Record<string, any>>();
const mockFindUser = jest.fn();
const mockDeleteUser = jest.fn();
const mockFindMembership = jest.fn();
const mockSaveMembership = jest.fn();

jest.mock('../models/User.js', () => {
  class MockUser {
    static findOne = mockFindUser;
    static findByIdAndDelete = mockDeleteUser;
    _id!: string; email!: string; passwordHash!: string; firstName!: string; lastName!: string; mustChangePassword!: boolean;
    constructor(data: Record<string, any>) { Object.assign(this, data); this._id = `user-${mockUsers.size + 1}`; }
    async save() { mockUsers.set(this.email, this); }
  }
  return { __esModule: true, default: MockUser };
});

jest.mock('../models/WorkspaceMember.js', () => {
  const WorkspaceRole = { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' };
  class MockWorkspaceMember {
    static findOne = mockFindMembership;
    workspaceId!: string; userId!: string; role!: string; _id = 'membership-1'; joinedAt = new Date();
    constructor(data: Record<string, any>) { Object.assign(this, data); }
    async save() { await mockSaveMembership(this); mockMemberships.set(`${this.workspaceId}:${this.userId}`, this); }
  }
  return { __esModule: true, default: MockWorkspaceMember, WorkspaceRole };
});

jest.mock('../utils/password.js', () => ({ hashPassword: jest.fn(async (password: string) => `bcrypt:${password}`) }));

import { addMember } from '../controllers/workspaceController.js';
import { WorkspaceRole } from '../models/WorkspaceMember.js';
import { hashPassword } from '../utils/password.js';

const workspaceId = 'workspace-1';
const validBody = { email: 'new.member@example.com', password: 'Temporary9Pass', role: 'admin' };

function responseHarness() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function invoke(body = validBody, userRole: string = WorkspaceRole.OWNER) {
  const req: any = { workspaceId, userRole, body };
  const res = responseHarness();
  await addMember(req, res);
  return res;
}

beforeEach(() => {
  mockUsers.clear(); mockMemberships.clear();
  jest.clearAllMocks();
  mockFindUser.mockImplementation(async ({ email }: { email: string }) => mockUsers.get(email) ?? null);
  mockFindMembership.mockImplementation(async ({ workspaceId: ws, userId }: { workspaceId: string; userId: string }) => mockMemberships.get(`${ws}:${userId}`) ?? null);
  mockDeleteUser.mockImplementation(async (id: string) => {
    for (const [email, user] of mockUsers) if (user._id === id) mockUsers.delete(email);
  });
  mockSaveMembership.mockResolvedValue(undefined);
});

describe('addMember controller', () => {
  it('creates a new account with a bcrypt hash, forced password change, selected role, and no hash in response', async () => {
    const res = await invoke();
    const created = mockUsers.get(validBody.email)!;
    expect(res.status).toHaveBeenCalledWith(201);
    expect(hashPassword).toHaveBeenCalledWith(validBody.password);
    expect(created.passwordHash).toBe(`bcrypt:${validBody.password}`);
    expect(created.mustChangePassword).toBe(true);
    expect(mockMemberships.get(`${workspaceId}:${created._id}`)?.role).toBe('admin');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('passwordHash');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(validBody.password);
  });

  it('adds existing user without changing their password or creating another account', async () => {
    const existing = { _id: 'existing-1', email: validBody.email, passwordHash: 'existing-bcrypt-hash', firstName: 'Existing', lastName: 'User' };
    mockUsers.set(existing.email, existing);
    const res = await invoke();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockUsers.size).toBe(1);
    expect(existing.passwordHash).toBe('existing-bcrypt-hash');
    expect(hashPassword).not.toHaveBeenCalled();
    expect(mockMemberships.has(`${workspaceId}:existing-1`)).toBe(true);
  });

  it('rejects duplicate membership with 409 and avoids user creation', async () => {
    const existing = { _id: 'existing-1', email: validBody.email, passwordHash: 'hash', firstName: 'Existing', lastName: 'User' };
    mockUsers.set(existing.email, existing);
    mockMemberships.set(`${workspaceId}:existing-1`, {});
    const res = await invoke();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toMatch(/already a member/i);
    expect(mockUsers.size).toBe(1);
  });

  it.each([
    [{ ...validBody, email: 'bad-email' }],
    [{ ...validBody, password: 'weak' }],
    [{ ...validBody, role: 'root' }],
  ])('rejects invalid member data with 400', async (body) => {
    const res = await invoke(body as typeof validBody);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUsers.size).toBe(0);
  });

  it.each(['member', 'viewer'])('rejects non-admin role %s from adding members', async (role) => {
    const res = await invoke(validBody, role);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockUsers.size).toBe(0);
  });

  it('allows an admin to add a member', async () => {
    const res = await invoke(validBody, WorkspaceRole.ADMIN);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rolls back the new user if membership persistence fails', async () => {
    mockSaveMembership.mockRejectedValueOnce(new Error('membership persistence failed'));
    const res = await invoke();
    expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
    expect(mockUsers.size).toBe(0);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not delete an existing user if membership persistence fails', async () => {
    const existing = { _id: 'existing-1', email: validBody.email, passwordHash: 'existing-hash', firstName: 'Existing', lastName: 'User' };
    mockUsers.set(existing.email, existing);
    mockSaveMembership.mockRejectedValueOnce(new Error('membership persistence failed'));
    const res = await invoke();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockUsers.get(existing.email)).toBe(existing);
    expect(existing.passwordHash).toBe('existing-hash');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
