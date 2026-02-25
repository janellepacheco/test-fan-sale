// MKPLS-362: GET /v1/admin/fan-sale/listings/:id/audit-log integration tests

import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockFanListingFindUnique = jest.fn()
const mockAuditLogFindMany = jest.fn()
const mockAuditLogCount = jest.fn()

const mockPrisma = {
  fanListing: { findUnique: mockFanListingFindUnique },
  listingAuditLog: {
    findMany: mockAuditLogFindMany,
    count: mockAuditLogCount,
  },
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADMIN_ID = 1
const SELLER_ID = 42
const NOW = new Date('2026-06-01T12:00:00Z')

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-001',
    listingId: 'listing-001',
    action: 'created',
    actorId: SELLER_ID,
    metadata: null,
    createdAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

describe('GET /v1/admin/fan-sale/listings/:id/audit-log', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildApp } = require('../../../../app')
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    jest.resetModules()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockFanListingFindUnique.mockResolvedValue({ id: 'listing-001' })
    mockAuditLogFindMany.mockResolvedValue([makeEntry()])
    mockAuditLogCount.mockResolvedValue(1)
  })

  // Helpers
  const adminToken = () => app.jwt.sign({ accountId: ADMIN_ID, role: 'admin' })
  const sellerToken = () => app.jwt.sign({ accountId: SELLER_ID })

  const inject = (listingId = 'listing-001', token?: string, query = '') => {
    const tok = token ?? adminToken()
    return app.inject({
      method: 'GET',
      url: `/v1/admin/fan-sale/listings/${listingId}/audit-log${query}`,
      headers: { authorization: `Bearer ${tok}` },
    })
  }

  // -------------------------------------------------------------------------
  // 200 — success
  // -------------------------------------------------------------------------

  it('returns 200 with listingId, entries, total, page, limit', async () => {
    const res = await inject()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.listingId).toBe('listing-001')
    expect(body.entries).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(20)
  })

  it('maps audit log entry fields correctly', async () => {
    mockAuditLogFindMany.mockResolvedValue([
      makeEntry({ action: 'price_updated', actorId: 99, metadata: { oldPrice: 50, newPrice: 45 } }),
    ])
    const res = await inject()
    const entry = JSON.parse(res.body).entries[0]
    expect(entry.action).toBe('price_updated')
    expect(entry.actorId).toBe(99)
    expect(entry.metadata).toEqual({ oldPrice: 50, newPrice: 45 })
    expect(entry.createdAt).toBe(NOW.toISOString())
  })

  it('returns 200 with empty entries array when listing has no audit logs', async () => {
    mockAuditLogFindMany.mockResolvedValue([])
    mockAuditLogCount.mockResolvedValue(0)
    const res = await inject()
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.entries).toEqual([])
    expect(body.total).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it('passes page and limit to the DB query', async () => {
    await inject('listing-001', undefined, '?page=2&limit=5')
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    )
  })

  it('reflects custom page and limit in the response', async () => {
    mockAuditLogFindMany.mockResolvedValue([])
    mockAuditLogCount.mockResolvedValue(0)
    const res = await inject('listing-001', undefined, '?page=3&limit=10')
    const body = JSON.parse(res.body)
    expect(body.page).toBe(3)
    expect(body.limit).toBe(10)
  })

  it('returns 400 when limit exceeds 100', async () => {
    const res = await inject('listing-001', undefined, '?limit=101')
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when page is 0', async () => {
    const res = await inject('listing-001', undefined, '?page=0')
    expect(res.statusCode).toBe(400)
  })

  it('sorts by createdAt descending', async () => {
    await inject()
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    )
  })

  // -------------------------------------------------------------------------
  // 404
  // -------------------------------------------------------------------------

  it('returns 404 when listing does not exist', async () => {
    mockFanListingFindUnique.mockResolvedValue(null)
    const res = await inject('nonexistent')
    expect(res.statusCode).toBe(404)
    expect(mockAuditLogFindMany).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Auth and role gate
  // -------------------------------------------------------------------------

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/fan-sale/listings/listing-001/audit-log',
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 when JWT has no admin role', async () => {
    const res = await inject('listing-001', sellerToken())
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).message).toContain('Admin role required')
  })

  it('returns 403 when JWT has a different role', async () => {
    const token = app.jwt.sign({ accountId: 99, role: 'support' })
    const res = await inject('listing-001', token)
    expect(res.statusCode).toBe(403)
  })

  it('allows access when JWT has role: admin', async () => {
    const res = await inject('listing-001', adminToken())
    expect(res.statusCode).toBe(200)
  })
})
