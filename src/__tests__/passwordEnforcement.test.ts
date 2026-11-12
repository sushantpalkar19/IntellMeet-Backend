const mockVerifyToken = jest.fn();
const mockFindById = jest.fn();
const mockFindOne = jest.fn();
let mockCurrentUser: any = null;
const mockHash = jest.fn();
const mockCompare = jest.fn();
const mockGenerateAccess = jest.fn(() => 'synthetic-access-token');
const mockGenerateRefresh = jest.fn(() => 'synthetic-refresh-token');

jest.mock('../utils/jwt.js', () => ({
  verifyAccessToken: mockVerifyToken,
  generateAccessToken: mockGenerateAccess,
  generateRefreshToken: mockGenerateRefresh,
  verifyRefreshToken: jest.fn(),
}));
jest.mock('../models/User.js', () => ({
  __esModule: true,
  default: { findById: mockFindById, findOne: mockFindOne },
}));
jest.mock('../utils/password.js', () => ({ hashPassword: mockHash, comparePassword: mockCompare }));

import { authenticate } from '../middleware/auth.js';
import { authenticateSocket } from '../socket/index.js';
import { changePassword, login } from '../controllers/authController.js';

function responseHarness() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('temporary-password protection and change flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = null;
    mockVerifyToken.mockReturnValue({ userId: 'synthetic-user-id', email: 'person@example.test' });
    mockFindOne.mockReturnValue({ select: jest.fn().mockImplementation(async () => mockCurrentUser) });
  });

  it('blocks temporary-password users and allows normal users on protected HTTP routes', async () => {
    const req: any = { headers: { authorization: 'Bearer synthetic-test-token' }, baseUrl: '/api/v1/workspaces', path: '/' };
    const res = responseHarness();
    const next = jest.fn();
    mockFindById.mockReturnValue({ select: async () => ({ mustChangePassword: true }) });
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    mockFindById.mockReturnValue({ select: async () => ({ mustChangePassword: false }) });
    await authenticate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks temporary-password socket auth and permits normal account auth', async () => {
    const socket: any = { id: 'synthetic-socket' };
    mockFindById.mockReturnValue({ select: async () => ({ mustChangePassword: true }) });
    await expect(authenticateSocket(socket, 'synthetic-test-token')).resolves.toBe(false);
    mockFindById.mockReturnValue({ select: async () => ({ mustChangePassword: false }) });
    await expect(authenticateSocket(socket, 'synthetic-test-token')).resolves.toBe(true);
    expect(socket.userId).toBe('synthetic-user-id');
  });

  it('changes the password flag and allows the new password at login, rejecting the old one', async () => {
    const user: any = {
      _id: 'synthetic-user-id', email: 'person@example.test', passwordHash: 'synthetic-hash:Temporary9Pass', mustChangePassword: true,
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockCurrentUser = user;
    mockFindById.mockReturnValue({ select: async () => user });
    mockCompare.mockImplementation(async (password: string, hash: string) => hash === `synthetic-hash:${password}`);
    mockHash.mockImplementation(async (password: string) => `synthetic-hash:${password}`);

    const changeRes = responseHarness();
    await changePassword({ userId: 'synthetic-user-id', body: { currentPassword: 'Temporary9Pass', newPassword: 'Changed8Password' } } as any, changeRes);
    expect(changeRes.status).toHaveBeenCalledWith(200);
    expect(user.mustChangePassword).toBe(false);
    expect(user.passwordHash).toBe('synthetic-hash:Changed8Password');

    mockFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
    const loginNewRes = responseHarness();
    await login({ body: { email: user.email, password: 'Changed8Password' } } as any, loginNewRes);
    expect(loginNewRes.status).toHaveBeenCalledWith(200);
    expect(JSON.stringify(loginNewRes.json.mock.calls[0][0])).not.toContain('passwordHash');

    const loginOldRes = responseHarness();
    await login({ body: { email: user.email, password: 'Temporary9Pass' } } as any, loginOldRes);
    expect(loginOldRes.status).toHaveBeenCalledWith(401);
  });
});
