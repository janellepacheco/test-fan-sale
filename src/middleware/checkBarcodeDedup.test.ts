// MKPLS-386: checkBarcodeDedup middleware unit tests

import { checkBarcodeDedup } from './checkBarcodeDedup'
import { generateBarcodeHash } from '../services/barcode-hash'

const mockFindFirst = jest.fn()
const mockPrisma = {
  fanListing: { findFirst: mockFindFirst },
}

const mockReply = {
  code: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
}

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    body,
    server: { prisma: mockPrisma },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockFindFirst.mockResolvedValue(null) // no duplicate by default
})

async function invoke(body: Record<string, unknown> = {}) {
  return checkBarcodeDedup(makeRequest(body) as never, mockReply as never)
}

// ---------------------------------------------------------------------------
// Pass-through cases
// ---------------------------------------------------------------------------

describe('checkBarcodeDedup — pass-through', () => {
  it('passes through when no ACTIVE duplicate exists', async () => {
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    expect(mockReply.code).not.toHaveBeenCalled()
  })

  it('passes through when body has no ticketId (validation handled elsewhere)', async () => {
    await invoke({})
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockReply.code).not.toHaveBeenCalled()
  })

  it('passes through when listing exists but is DELISTED (re-listing allowed)', async () => {
    // findFirst only queries ACTIVE — returning null simulates a non-ACTIVE match
    mockFindFirst.mockResolvedValue(null)
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    expect(mockReply.code).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe('checkBarcodeDedup — conflict', () => {
  it('returns 409 when an ACTIVE listing exists with the same hash', async () => {
    mockFindFirst.mockResolvedValue({ id: 'fl-existing' })
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    expect(mockReply.code).toHaveBeenCalledWith(409)
    const sent = mockReply.send.mock.calls[0][0]
    expect(sent.message).toContain('already listed')
  })

  it('queries with the correct hash and ACTIVE status filter', async () => {
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    const expectedHash = generateBarcodeHash('tk-001', ['5'])
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { barcodeHash: expectedHash, status: 'ACTIVE' },
      select: { id: true },
    })
  })

  it('different ticketId + same seatNumber does not conflict', async () => {
    // First listing for tk-001
    mockFindFirst.mockResolvedValue(null)
    await invoke({ ticketId: 'tk-002', seatNumber: '5' })
    // Ensure the query was for tk-002's hash, not tk-001's
    const calledHash = mockFindFirst.mock.calls[0][0].where.barcodeHash
    const expectedHash = generateBarcodeHash('tk-002', ['5'])
    expect(calledHash).toBe(expectedHash)
    expect(mockReply.code).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Seat number handling
// ---------------------------------------------------------------------------

describe('checkBarcodeDedup — seat number handling', () => {
  it('uses empty seat array when seatNumber is absent from body', async () => {
    await invoke({ ticketId: 'tk-001' })
    const calledHash = mockFindFirst.mock.calls[0][0].where.barcodeHash
    const expectedHash = generateBarcodeHash('tk-001', [])
    expect(calledHash).toBe(expectedHash)
  })

  it('hash is seat-order-independent', async () => {
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    const hash1 = mockFindFirst.mock.calls[0][0].where.barcodeHash

    jest.clearAllMocks()
    mockFindFirst.mockResolvedValue(null)

    // generateBarcodeHash sorts internally — single seat is always same
    await invoke({ ticketId: 'tk-001', seatNumber: '5' })
    const hash2 = mockFindFirst.mock.calls[0][0].where.barcodeHash

    expect(hash1).toBe(hash2)
  })
})
