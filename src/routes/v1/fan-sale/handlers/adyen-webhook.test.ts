// MKPLS-370: Adyen KYC webhook handler tests
//
// Pattern: jest.doMock (non-hoisted) + dynamic require + fp() wrapper on Prisma mock.
// Notifications are mocked via jest.doMock on the notifications module so the
// StubNotificationService constructor in index.ts returns a test double.
//
// HMAC signatures in integration tests are REAL — generated with the same key
// set in jest.setup.ts (ADYEN_WEBHOOK_HMAC_KEY). This tests the full validation path.

import { createHmac } from 'crypto'
import { validateHmac } from './adyen-webhook'
import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockWebhookEventFindUnique = jest.fn()
const mockWebhookEventCreate = jest.fn().mockResolvedValue({})
const mockSellerPaymentAccountFindFirst = jest.fn()
const mockSellerPaymentAccountUpdate = jest.fn().mockResolvedValue({})
const mockTransaction = jest
  .fn()
  .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))

const mockPrisma = {
  webhookEvent: {
    findUnique: mockWebhookEventFindUnique,
    create: mockWebhookEventCreate,
  },
  sellerPaymentAccount: {
    findFirst: mockSellerPaymentAccountFindFirst,
    update: mockSellerPaymentAccountUpdate,
  },
  $transaction: mockTransaction,
}

const mockSendKycVerified = jest.fn().mockResolvedValue(undefined)
const mockSendKycFailed = jest.fn().mockResolvedValue(undefined)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const HMAC_KEY_HEX = process.env.ADYEN_WEBHOOK_HMAC_KEY!
const ACCOUNT_HOLDER_ID = 'AH0000000001'
const SELLER_ID = 77

function sign(bodyString: string): string {
  const key = Buffer.from(HMAC_KEY_HEX, 'hex')
  return createHmac('sha256', key).update(Buffer.from(bodyString)).digest('base64')
}

function makePayload(overrides: Record<string, unknown> = {}): {
  bodyString: string
  signature: string
} {
  const body = {
    notificationId: 'notif-001',
    type: 'balancePlatform.accountHolder.updated',
    data: {
      id: ACCOUNT_HOLDER_ID,
      verification: { status: 'valid' },
    },
    ...overrides,
  }
  const bodyString = JSON.stringify(body)
  return { bodyString, signature: sign(bodyString) }
}

// ---------------------------------------------------------------------------
// Unit tests — validateHmac (pure function, no Fastify)
// ---------------------------------------------------------------------------

describe('validateHmac', () => {
  const keyHex = 'deadbeef'.repeat(8)
  const input = Buffer.from('hello adyen')
  const validSig = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(input).digest('base64')

  it('returns true for a correct signature', () => {
    expect(validateHmac(input, validSig, keyHex)).toBe(true)
  })

  it('returns false when the signature is wrong', () => {
    expect(validateHmac(input, 'wrong-sig', keyHex)).toBe(false)
  })

  it('returns false when the key is an empty string', () => {
    expect(validateHmac(input, validSig, '')).toBe(false)
  })

  it('returns false when the signature is an empty string', () => {
    expect(validateHmac(input, '', keyHex)).toBe(false)
  })

  it('uses timing-safe comparison (length mismatch returns false, not throws)', () => {
    const shortSig = validSig.slice(0, 10)
    expect(() => validateHmac(input, shortSig, keyHex)).not.toThrow()
    expect(validateHmac(input, shortSig, keyHex)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — full Fastify app
// ---------------------------------------------------------------------------

describe('POST /v1/fan-sale/webhooks/adyen', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    jest.doMock('../../../../plugins/prisma', () =>
      fp(async (fastify: FastifyInstance) => {
        fastify.decorate('prisma', mockPrisma)
      }),
    )

    jest.doMock('../../../../services/notifications', () => ({
      StubNotificationService: jest.fn().mockImplementation(() => ({
        sendKycVerified: mockSendKycVerified,
        sendKycFailed: mockSendKycFailed,
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
    // Default: no duplicate, account found
    mockWebhookEventFindUnique.mockResolvedValue(null)
    mockSellerPaymentAccountFindFirst.mockResolvedValue({
      id: 'spa-001',
      sellerId: SELLER_ID,
      adyenAccountHolderId: ACCOUNT_HOLDER_ID,
      kycStatus: 'PENDING',
    })
  })

  const inject = (bodyString: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/fan-sale/webhooks/adyen',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyString,
    })

  // -------------------------------------------------------------------------
  // 401 — HMAC failures
  // -------------------------------------------------------------------------

  it('returns 401 when HmacSignature header is missing', async () => {
    const { bodyString } = makePayload()
    const res = await inject(bodyString)
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when HmacSignature does not match', async () => {
    const { bodyString } = makePayload()
    const res = await inject(bodyString, { hmacsignature: 'nottherightsig' })
    expect(res.statusCode).toBe(401)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — KYC_VERIFIED transition
  // -------------------------------------------------------------------------

  it('updates kycStatus to KYC_VERIFIED and returns 200 when status is "valid"', async () => {
    const { bodyString, signature } = makePayload({ data: { id: ACCOUNT_HOLDER_ID, verification: { status: 'valid' } } })
    const res = await inject(bodyString, { hmacsignature: signature })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ received: true })
    expect(mockSellerPaymentAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'KYC_VERIFIED' } }),
    )
    expect(mockWebhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notificationId: 'notif-001' }) }),
    )
  })

  it('calls sendKycVerified (fire-and-forget) on KYC_VERIFIED transition', async () => {
    const { bodyString, signature } = makePayload()
    await inject(bodyString, { hmacsignature: signature })

    // Notification is fire-and-forget; need to let microtasks flush
    await Promise.resolve()
    expect(mockSendKycVerified).toHaveBeenCalledWith(SELLER_ID)
    expect(mockSendKycFailed).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — KYC_FAILED transition
  // -------------------------------------------------------------------------

  it('updates kycStatus to KYC_FAILED and calls sendKycFailed when status is "invalid"', async () => {
    const { bodyString, signature } = makePayload({
      notificationId: 'notif-002',
      data: { id: ACCOUNT_HOLDER_ID, verification: { status: 'invalid' } },
    })
    const res = await inject(bodyString, { hmacsignature: signature })

    expect(res.statusCode).toBe(200)
    expect(mockSellerPaymentAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'KYC_FAILED' } }),
    )
    await Promise.resolve()
    expect(mockSendKycFailed).toHaveBeenCalledWith(SELLER_ID)
    expect(mockSendKycVerified).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — PENDING / unknown status (no status change notification)
  // -------------------------------------------------------------------------

  it('updates kycStatus to PENDING for unknown verification status; no notification sent', async () => {
    const { bodyString, signature } = makePayload({
      notificationId: 'notif-003',
      data: { id: ACCOUNT_HOLDER_ID, verification: { status: 'dataProvided' } },
    })
    const res = await inject(bodyString, { hmacsignature: signature })

    expect(res.statusCode).toBe(200)
    expect(mockSellerPaymentAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'PENDING' } }),
    )
    await Promise.resolve()
    expect(mockSendKycVerified).not.toHaveBeenCalled()
    expect(mockSendKycFailed).not.toHaveBeenCalled()
  })

  it('updates to PENDING when verification object is absent', async () => {
    const body = { notificationId: 'notif-004', type: 'balancePlatform.accountHolder.updated', data: { id: ACCOUNT_HOLDER_ID } }
    const bodyString = JSON.stringify(body)
    const res = await inject(bodyString, { hmacsignature: sign(bodyString) })

    expect(res.statusCode).toBe(200)
    expect(mockSellerPaymentAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'PENDING' } }),
    )
  })

  // -------------------------------------------------------------------------
  // 200 — idempotency (duplicate notificationId)
  // -------------------------------------------------------------------------

  it('returns 200 without writing DB when notificationId was already processed', async () => {
    mockWebhookEventFindUnique.mockResolvedValue({ id: 'we-001', notificationId: 'notif-001' })

    const { bodyString, signature } = makePayload()
    const res = await inject(bodyString, { hmacsignature: signature })

    expect(res.statusCode).toBe(200)
    expect(mockTransaction).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mockSendKycVerified).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — unknown accountHolderId (orphaned event)
  // -------------------------------------------------------------------------

  it('returns 200 without writing DB when accountHolderId has no matching seller', async () => {
    mockSellerPaymentAccountFindFirst.mockResolvedValue(null)

    const { bodyString, signature } = makePayload()
    const res = await inject(bodyString, { hmacsignature: signature })

    expect(res.statusCode).toBe(200)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — unknown event type (graceful ack)
  // -------------------------------------------------------------------------

  it('returns 200 without processing when event type is not accountHolder.updated', async () => {
    const body = { notificationId: 'notif-005', type: 'balancePlatform.transfer.created', data: { id: ACCOUNT_HOLDER_ID } }
    const bodyString = JSON.stringify(body)
    const res = await inject(bodyString, { hmacsignature: sign(bodyString) })

    expect(res.statusCode).toBe(200)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 200 — notification failure is non-blocking
  // -------------------------------------------------------------------------

  it('returns 200 even when notification service throws', async () => {
    mockSendKycVerified.mockRejectedValue(new Error('Braze API down'))

    const { bodyString, signature } = makePayload()
    const res = await inject(bodyString, { hmacsignature: signature })

    // Request ack is unaffected by notification failure
    expect(res.statusCode).toBe(200)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // Auth bypass — no JWT required
  // -------------------------------------------------------------------------

  it('does NOT require a JWT (webhook endpoint bypasses auth middleware)', async () => {
    // No authorization header — should still succeed with valid HMAC
    const { bodyString, signature } = makePayload({ notificationId: 'notif-noauth' })
    const res = await inject(bodyString, { hmacsignature: signature })
    // If auth middleware ran, it would return 401; 200 confirms it's bypassed
    expect(res.statusCode).toBe(200)
  })
})
