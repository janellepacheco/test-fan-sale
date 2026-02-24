// MKPLS-368: onboard handler integration tests
//
// Pattern: jest.doMock (non-hoisted) + dynamic require + fp() wrapper on Prisma mock.
// The Adyen client is mocked at the module level so that when index.ts calls
// `new AdyenBalancePlatformClient(...)` it receives the test double.

import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Shared mock state — defined before doMock so factories can close over them
// ---------------------------------------------------------------------------

const mockCreateLegalEntity = jest.fn()
const mockCreateAccountHolder = jest.fn()
const mockCreateBalanceAccount = jest.fn()
const mockGetOnboardingUrl = jest.fn()

const mockSellerPaymentAccountFindUnique = jest.fn()
const mockSellerPaymentAccountUpsert = jest.fn()

const mockPrisma = {
  sellerPaymentAccount: {
    findUnique: mockSellerPaymentAccountFindUnique,
    upsert: mockSellerPaymentAccountUpsert,
  },
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ONBOARDING_URL = 'https://hosted.adyen.com/onboarding/abc123'
const LEGAL_ENTITY_ID = 'LE0000000001'
const ACCOUNT_HOLDER_ID = 'AH0000000001'
const BALANCE_ACCOUNT_ID = 'BA0000000001'

function stubAdyenSuccess() {
  mockCreateLegalEntity.mockResolvedValue({ legalEntityId: LEGAL_ENTITY_ID })
  mockCreateAccountHolder.mockResolvedValue({ accountHolderId: ACCOUNT_HOLDER_ID })
  mockCreateBalanceAccount.mockResolvedValue({ balanceAccountId: BALANCE_ACCOUNT_ID })
  mockGetOnboardingUrl.mockResolvedValue({ url: ONBOARDING_URL })
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

describe('POST /v1/fan-sale/payout/onboard', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    jest.doMock('../../../../services/adyen', () => ({
      AdyenBalancePlatformClient: jest.fn().mockImplementation(() => ({
        createLegalEntity: mockCreateLegalEntity,
        createAccountHolder: mockCreateAccountHolder,
        createBalanceAccount: mockCreateBalanceAccount,
        getOnboardingUrl: mockGetOnboardingUrl,
      })),
    }))

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
  })

  // Helper: inject a request with a real signed JWT
  const inject = (body: unknown, sellerId = 42) => {
    const token = app.jwt.sign({ accountId: sellerId })
    return app.inject({
      method: 'POST',
      url: '/v1/fan-sale/payout/onboard',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    })
  }

  // -------------------------------------------------------------------------
  // 201 — new onboarding (no existing account)
  // -------------------------------------------------------------------------

  it('creates Adyen entities, saves account, and returns 201 with onboardingUrl', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    mockSellerPaymentAccountUpsert.mockResolvedValue({})
    stubAdyenSuccess()

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ onboardingUrl: ONBOARDING_URL, status: 'PENDING' })
  })

  it('calls Adyen in the correct sequence: legal entity → account holder → balance account → URL', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    mockSellerPaymentAccountUpsert.mockResolvedValue({})
    stubAdyenSuccess()

    await inject({ provider: 'adyen' })

    const order = [
      mockCreateLegalEntity.mock.invocationCallOrder[0],
      mockCreateAccountHolder.mock.invocationCallOrder[0],
      mockCreateBalanceAccount.mock.invocationCallOrder[0],
      mockGetOnboardingUrl.mock.invocationCallOrder[0],
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))

    expect(mockCreateAccountHolder).toHaveBeenCalledWith(LEGAL_ENTITY_ID)
    expect(mockCreateBalanceAccount).toHaveBeenCalledWith(ACCOUNT_HOLDER_ID)
    expect(mockGetOnboardingUrl).toHaveBeenCalledWith(ACCOUNT_HOLDER_ID)
  })

  it('upserts the account with all Adyen IDs and kycStatus PENDING', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    mockSellerPaymentAccountUpsert.mockResolvedValue({})
    stubAdyenSuccess()

    await inject({ provider: 'adyen' }, 99)

    expect(mockSellerPaymentAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sellerId: 99 },
        create: expect.objectContaining({
          sellerId: 99,
          adyenLegalEntityId: LEGAL_ENTITY_ID,
          adyenAccountHolderId: ACCOUNT_HOLDER_ID,
          adyenBalanceAccountId: BALANCE_ACCOUNT_ID,
          onboardingUrl: ONBOARDING_URL,
          kycStatus: 'PENDING',
        }),
      }),
    )
  })

  // -------------------------------------------------------------------------
  // 200 — idempotent: seller already PENDING with a stored URL
  // -------------------------------------------------------------------------

  it('returns 200 and the existing URL without calling Adyen when PENDING + URL stored', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue({
      sellerId: 42,
      kycStatus: 'PENDING',
      onboardingUrl: ONBOARDING_URL,
    })

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ onboardingUrl: ONBOARDING_URL, status: 'PENDING' })
    expect(mockCreateLegalEntity).not.toHaveBeenCalled()
    expect(mockSellerPaymentAccountUpsert).not.toHaveBeenCalled()
  })

  it('calls Adyen again when PENDING but no URL is stored yet (race/partial create)', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue({
      sellerId: 42,
      kycStatus: 'PENDING',
      onboardingUrl: null,
    })
    mockSellerPaymentAccountUpsert.mockResolvedValue({})
    stubAdyenSuccess()

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(201)
    expect(mockCreateLegalEntity).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 201 — re-onboard after KYC_FAILED
  // -------------------------------------------------------------------------

  it('allows re-onboarding when kycStatus is KYC_FAILED, upserts with new Adyen IDs', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue({
      sellerId: 42,
      kycStatus: 'KYC_FAILED',
      onboardingUrl: 'https://expired.adyen.com/old',
    })
    mockSellerPaymentAccountUpsert.mockResolvedValue({})
    stubAdyenSuccess()

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(201)
    expect(mockSellerPaymentAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          onboardingUrl: ONBOARDING_URL,
          kycStatus: 'PENDING',
        }),
      }),
    )
  })

  // -------------------------------------------------------------------------
  // 409 — already KYC verified
  // -------------------------------------------------------------------------

  it('returns 409 when seller is already KYC_VERIFIED', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue({
      sellerId: 42,
      kycStatus: 'KYC_VERIFIED',
      onboardingUrl: null,
    })

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Conflict',
      message: expect.stringContaining('KYC verified'),
    })
    expect(mockCreateLegalEntity).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 400 — bad provider
  // -------------------------------------------------------------------------

  it('returns 400 when provider is "braintree"', async () => {
    const res = await inject({ provider: 'braintree' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Bad Request',
      message: expect.stringContaining("'adyen'"),
    })
  })

  it('returns 400 when body is missing provider', async () => {
    const res = await inject({})

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when body is empty', async () => {
    const token = app.jwt.sign({ accountId: 42 })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/payout/onboard',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(400)
  })

  // -------------------------------------------------------------------------
  // 502 — Adyen API failure
  // -------------------------------------------------------------------------

  it('returns 502 when Adyen createLegalEntity throws', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    mockCreateLegalEntity.mockRejectedValue(new Error('Adyen API error 503: Service Unavailable'))

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Bad Gateway',
      message: expect.stringContaining('Adyen'),
    })
    expect(mockSellerPaymentAccountUpsert).not.toHaveBeenCalled()
  })

  it('returns 502 when Adyen getOnboardingUrl throws', async () => {
    mockSellerPaymentAccountFindUnique.mockResolvedValue(null)
    mockCreateLegalEntity.mockResolvedValue({ legalEntityId: LEGAL_ENTITY_ID })
    mockCreateAccountHolder.mockResolvedValue({ accountHolderId: ACCOUNT_HOLDER_ID })
    mockCreateBalanceAccount.mockResolvedValue({ balanceAccountId: BALANCE_ACCOUNT_ID })
    mockGetOnboardingUrl.mockRejectedValue(new Error('Adyen API error 500'))

    const res = await inject({ provider: 'adyen' })

    expect(res.statusCode).toBe(502)
    expect(mockSellerPaymentAccountUpsert).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 401 — no auth
  // -------------------------------------------------------------------------

  it('returns 401 when no JWT is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/fan-sale/payout/onboard',
      payload: { provider: 'adyen' },
    })

    expect(res.statusCode).toBe(401)
  })
})
