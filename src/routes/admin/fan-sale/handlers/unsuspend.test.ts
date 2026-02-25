// MKPLS-388: admin unsuspend handler unit tests

import { unsuspendHandler } from './unsuspend'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindUnique = jest.fn()
const mockUpdate = jest.fn()
const mockSellerFlagCreate = jest.fn()
const mockTransaction = jest.fn()

const mockPrisma = {
  sellerPaymentAccount: {
    findUnique: mockFindUnique,
    update: mockUpdate,
  },
  sellerFlag: {
    create: mockSellerFlagCreate,
  },
  $transaction: mockTransaction,
}

// $transaction with array: execute all ops in sequence and return results
mockTransaction.mockImplementation((ops: unknown[]) => Promise.all(ops))

function makeRequest(
  sellerId: string,
  body: Record<string, unknown> = { reason: 'resolved by support' },
  adminAccountId = 99,
): Record<string, unknown> {
  return {
    params: { sellerId },
    body,
    server: { prisma: mockPrisma },
    user: { accountId: adminAccountId },
  }
}

const mockReply = {
  code: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockFindUnique.mockResolvedValue({ fanSaleSuspended: true })
  mockUpdate.mockResolvedValue({ sellerId: 42, fanSaleSuspended: false })
  mockSellerFlagCreate.mockResolvedValue({ id: 'sf-001' })
  mockTransaction.mockImplementation((ops: unknown[]) => Promise.all(ops))
})

async function invoke(
  sellerId: string,
  body: Record<string, unknown> = { reason: 'resolved' },
  adminId = 99,
) {
  return unsuspendHandler(
    makeRequest(sellerId, body, adminId) as never,
    mockReply as never,
  )
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('unsuspend — success', () => {
  it('returns 200 with sellerId, fanSaleSuspended false, and reason', async () => {
    await invoke('42')
    expect(mockReply.code).toHaveBeenCalledWith(200)
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.sellerId).toBe(42)
    expect(sent.fanSaleSuspended).toBe(false)
    expect(sent.reason).toBe('resolved')
    expect(sent.unsuspendedBy).toBe(99)
  })

  it('calls $transaction to atomically unsuspend + create audit flag', async () => {
    await invoke('42')
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const ops = mockTransaction.mock.calls[0][0]
    expect(ops).toHaveLength(2)
  })

  it('creates SellerFlag with reason unsuspended and admin metadata', async () => {
    await invoke('42', { reason: 'appeal approved' }, 7)
    // sellerFlag.create must have been called (via transaction)
    expect(mockSellerFlagCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sellerId: 42,
        reason: 'unsuspended',
        actorId: 7,
        metadata: { adminReason: 'appeal approved' },
      }),
    })
  })

  it('updates sellerPaymentAccount to fanSaleSuspended=false', async () => {
    await invoke('42')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { sellerId: 42 },
      data: { fanSaleSuspended: false },
    })
  })
})

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('unsuspend — validation', () => {
  it('returns 400 for non-numeric sellerId', async () => {
    await invoke('abc')
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })

  it('returns 400 when reason body is missing', async () => {
    await invoke('42', {})
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })

  it('returns 400 when reason is empty string', async () => {
    await invoke('42', { reason: '' })
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })
})

// ---------------------------------------------------------------------------
// Not found / conflict
// ---------------------------------------------------------------------------

describe('unsuspend — not found / conflict', () => {
  it('returns 404 when seller account does not exist', async () => {
    mockFindUnique.mockResolvedValue(null)
    await invoke('99')
    expect(mockReply.code).toHaveBeenCalledWith(404)
  })

  it('returns 409 when seller is not currently suspended', async () => {
    mockFindUnique.mockResolvedValue({ fanSaleSuspended: false })
    await invoke('42')
    expect(mockReply.code).toHaveBeenCalledWith(409)
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.message).toContain('not suspended')
  })
})

// ---------------------------------------------------------------------------
// requireNotSuspended middleware (separate unit tests)
// ---------------------------------------------------------------------------

import { requireNotSuspended } from '../../../../middleware/requireNotSuspended'

describe('requireNotSuspended middleware', () => {
  const suspendedMockPrisma = {
    sellerPaymentAccount: { findUnique: jest.fn() },
  }
  const middlewareReply = { code: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }

  function makeMiddlewareRequest(accountId: number, suspended: boolean) {
    suspendedMockPrisma.sellerPaymentAccount.findUnique.mockResolvedValue({
      fanSaleSuspended: suspended,
    })
    return {
      user: { accountId },
      server: { prisma: suspendedMockPrisma },
    }
  }

  beforeEach(() => jest.clearAllMocks())

  it('passes through when seller is not suspended', async () => {
    const req = makeMiddlewareRequest(1, false)
    await requireNotSuspended(req as never, middlewareReply as never)
    expect(middlewareReply.code).not.toHaveBeenCalled()
  })

  it('returns 403 when seller is suspended', async () => {
    const req = makeMiddlewareRequest(1, true)
    await requireNotSuspended(req as never, middlewareReply as never)
    expect(middlewareReply.code).toHaveBeenCalledWith(403)
    const sent = middlewareReply.send.mock.calls[0][0]
    expect(sent.message).toContain('suspended')
  })

  it('passes through when seller has no payment account (not yet onboarded)', async () => {
    suspendedMockPrisma.sellerPaymentAccount.findUnique.mockResolvedValue(null)
    const req = {
      user: { accountId: 5 },
      server: { prisma: suspendedMockPrisma },
    }
    await requireNotSuspended(req as never, middlewareReply as never)
    expect(middlewareReply.code).not.toHaveBeenCalled()
  })
})
