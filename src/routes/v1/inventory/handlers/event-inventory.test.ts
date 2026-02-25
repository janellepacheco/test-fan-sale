// MKPLS-375 + MKPLS-378: event inventory handler unit tests

import { makeEventInventoryHandler } from './event-inventory'
import { HermesClient } from '../../../../services/hermes'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFanListingFindMany = jest.fn()
const mockPrisma = {
  fanListing: { findMany: mockFanListingFindMany },
}

const mockGetEventInventory = jest.fn()
const mockHermes = { getEventInventory: mockGetEventInventory } as unknown as HermesClient

const mockLogger = { error: jest.fn(), info: jest.fn() }

// Build a minimal fake FastifyRequest
function makeRequest(
  eventId: string,
  query: Record<string, string> = {},
): Record<string, unknown> {
  return {
    params: { eventId },
    query,
    server: { prisma: mockPrisma },
    log: mockLogger,
  }
}

const mockReply = {
  code: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const FUTURE = new Date(Date.now() + 4 * TWO_HOURS_MS) // 8h from now — safe

function makeFanListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fl-001',
    section: 'A',
    row: '1',
    seatNumber: '5',
    askingPrice: { toNumber: () => 75.0 },
    ticketSource: 'vivid_seats',
    expiresAt: FUTURE,
    ...overrides,
  }
}

function makeBrokerListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bl-001',
    source: 'broker' as const,
    section: 'B',
    row: '2',
    quantity: 2,
    price: 120.0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockFanListingFindMany.mockResolvedValue([makeFanListing()])
  mockGetEventInventory.mockResolvedValue([makeBrokerListing()])
})

const handler = makeEventInventoryHandler(mockHermes)

async function invoke(eventId: string, query: Record<string, string> = {}) {
  return handler(makeRequest(eventId, query) as never, mockReply as never)
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('event inventory — response shape', () => {
  it('returns eventId, listings array, and total', async () => {
    const res = await invoke('event-001')
    expect(res.eventId).toBe('event-001')
    expect(Array.isArray(res.listings)).toBe(true)
    expect(typeof res.total).toBe('number')
  })

  it('merges fan and broker listings in a single array', async () => {
    const res = await invoke('event-001')
    expect(res.listings).toHaveLength(2)
    expect(res.listings.map((l) => l.source)).toEqual(
      expect.arrayContaining(['fan', 'broker']),
    )
  })

  it('fan listing has source fan and ticketSource field', async () => {
    mockGetEventInventory.mockResolvedValue([])
    const res = await invoke('event-001')
    const fan = res.listings[0]
    expect(fan.source).toBe('fan')
    expect(fan.quantity).toBe(1)
    expect(fan.ticketSource).toBe('vivid_seats')
  })

  it('broker listing has source broker', async () => {
    mockFanListingFindMany.mockResolvedValue([])
    const res = await invoke('event-001')
    expect(res.listings[0].source).toBe('broker')
  })
})

// ---------------------------------------------------------------------------
// 2-hour cutoff rule
// ---------------------------------------------------------------------------

describe('event inventory — 2-hour cutoff', () => {
  it('queries fan listings with expiresAt > now+2h', async () => {
    await invoke('event-001')
    const where = mockFanListingFindMany.mock.calls[0][0].where
    const cutoff: Date = where.expiresAt.gt
    const expectedMin = Date.now() + 2 * 60 * 60 * 1000 - 100
    const expectedMax = Date.now() + 2 * 60 * 60 * 1000 + 100
    expect(cutoff.getTime()).toBeGreaterThan(expectedMin)
    expect(cutoff.getTime()).toBeLessThan(expectedMax)
  })
})

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('event inventory — sorting', () => {
  beforeEach(() => {
    mockFanListingFindMany.mockResolvedValue([
      makeFanListing({ id: 'fl-cheap', askingPrice: { toNumber: () => 50 } }),
      makeFanListing({ id: 'fl-expensive', askingPrice: { toNumber: () => 200 } }),
    ])
    mockGetEventInventory.mockResolvedValue([
      makeBrokerListing({ id: 'bl-mid', price: 100 }),
    ])
  })

  it('defaults to price_asc', async () => {
    const res = await invoke('event-001')
    expect(res.listings.map((l) => l.price)).toEqual([50, 100, 200])
  })

  it('sorts price_desc when requested', async () => {
    const res = await invoke('event-001', { sortBy: 'price_desc' })
    expect(res.listings.map((l) => l.price)).toEqual([200, 100, 50])
  })
})

// ---------------------------------------------------------------------------
// Filtering (MKPLS-375)
// ---------------------------------------------------------------------------

describe('event inventory — filtering', () => {
  it('passes section filter to DB query', async () => {
    await invoke('event-001', { section: 'A' })
    const where = mockFanListingFindMany.mock.calls[0][0].where
    expect(where.section).toMatchObject({ equals: 'A', mode: 'insensitive' })
  })

  it('passes section filter to Hermes', async () => {
    await invoke('event-001', { section: 'A' })
    expect(mockGetEventInventory).toHaveBeenCalledWith('event-001', expect.objectContaining({ section: 'A' }))
  })

  it('passes minPrice to DB and Hermes', async () => {
    await invoke('event-001', { minPrice: '50' })
    expect(mockFanListingFindMany.mock.calls[0][0].where.askingPrice).toMatchObject({ gte: 50 })
    expect(mockGetEventInventory).toHaveBeenCalledWith('event-001', expect.objectContaining({ minPrice: 50 }))
  })

  it('passes maxPrice to DB and Hermes', async () => {
    await invoke('event-001', { maxPrice: '100' })
    expect(mockFanListingFindMany.mock.calls[0][0].where.askingPrice).toMatchObject({ lte: 100 })
    expect(mockGetEventInventory).toHaveBeenCalledWith('event-001', expect.objectContaining({ maxPrice: 100 }))
  })

  it('excludes fan listings when minQuantity > 1', async () => {
    mockGetEventInventory.mockResolvedValue([makeBrokerListing({ quantity: 2 })])
    const res = await invoke('event-001', { minQuantity: '2' })
    expect(res.listings.every((l) => l.source === 'broker')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Source filter (MKPLS-378)
// ---------------------------------------------------------------------------

describe('event inventory — source filter (MKPLS-378)', () => {
  it('returns only fan listings when source=fan', async () => {
    const res = await invoke('event-001', { source: 'fan' })
    expect(mockGetEventInventory).not.toHaveBeenCalled()
    expect(res.listings.every((l) => l.source === 'fan')).toBe(true)
  })

  it('returns only broker listings when source=broker', async () => {
    const res = await invoke('event-001', { source: 'broker' })
    expect(mockFanListingFindMany).not.toHaveBeenCalled()
    expect(res.listings.every((l) => l.source === 'broker')).toBe(true)
  })

  it('returns both when source is omitted', async () => {
    const res = await invoke('event-001')
    expect(mockFanListingFindMany).toHaveBeenCalled()
    expect(mockGetEventInventory).toHaveBeenCalled()
    expect(res.listings).toHaveLength(2)
  })

  it('returns 400 for invalid source value', async () => {
    await invoke('event-001', { source: 'invalid' })
    expect(mockReply.code).toHaveBeenCalledWith(400)
  })
})

// ---------------------------------------------------------------------------
// Hermes failure — graceful degradation
// ---------------------------------------------------------------------------

describe('event inventory — Hermes degradation', () => {
  it('returns fan-only results and logs error when Hermes throws', async () => {
    mockGetEventInventory.mockRejectedValue(new Error('Hermes down'))
    const res = await invoke('event-001')
    expect(res.listings.every((l) => l.source === 'fan')).toBe(true)
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('total reflects fan-only count when Hermes fails', async () => {
    mockGetEventInventory.mockRejectedValue(new Error('Hermes down'))
    const res = await invoke('event-001')
    expect(res.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

describe('event inventory — empty results', () => {
  it('returns empty listings array and total 0 when no results', async () => {
    mockFanListingFindMany.mockResolvedValue([])
    mockGetEventInventory.mockResolvedValue([])
    const res = await invoke('event-001')
    expect(res.listings).toEqual([])
    expect(res.total).toBe(0)
  })
})
