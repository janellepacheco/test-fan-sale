// MKPLS-345: AdyenPayoutService unit tests

import { AdyenPayoutService } from './adyen-payout'
import { KycStatus } from '../types'

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(...responses: Array<{ ok: boolean; body?: unknown; status?: number }>) {
  let call = 0
  jest.spyOn(global, 'fetch').mockImplementation(async () => {
    const r = responses[call++] ?? { ok: false, status: 500 }
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
    } as Response
  })
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeService() {
  return new AdyenPayoutService({
    apiKey: 'test-key',
    lemBaseUrl: 'http://lem',
    bclBaseUrl: 'http://bcl',
    transfersBaseUrl: 'http://btl',
    _retryDelayMs: 0, // no delay in unit tests
  })
}

afterEach(() => {
  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// onboardSeller
// ---------------------------------------------------------------------------

describe('AdyenPayoutService.onboardSeller', () => {
  it('calls createLegalEntity → createAccountHolder → createBalanceAccount and returns all IDs', async () => {
    mockFetch(
      { ok: true, body: { id: 'le-001' } },  // createLegalEntity
      { ok: true, body: { id: 'ah-001' } },  // createAccountHolder
      { ok: true, body: { id: 'ba-001' } },  // createBalanceAccount
    )

    const svc = makeService()
    const result = await svc.onboardSeller()

    expect(result).toEqual({
      legalEntityId: 'le-001',
      accountHolderId: 'ah-001',
      balanceAccountId: 'ba-001',
    })

    const fetchMock = global.fetch as jest.Mock
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('http://lem/legalEntities')
    expect(fetchMock.mock.calls[1][0]).toContain('accountHolders')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ legalEntityId: 'le-001' })
    expect(fetchMock.mock.calls[2][0]).toContain('balanceAccounts')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ accountHolderId: 'ah-001' })
  })

  it('throws when createLegalEntity returns a non-ok status', async () => {
    mockFetch({ ok: false, status: 422 })
    await expect(makeService().onboardSeller()).rejects.toThrow('createLegalEntity failed: 422')
  })

  it('throws when createAccountHolder returns a non-ok status', async () => {
    mockFetch(
      { ok: true, body: { id: 'le-001' } },
      { ok: false, status: 500 },
    )
    await expect(makeService().onboardSeller()).rejects.toThrow('createAccountHolder failed: 500')
  })

  it('throws when createBalanceAccount returns a non-ok status', async () => {
    mockFetch(
      { ok: true, body: { id: 'le-001' } },
      { ok: true, body: { id: 'ah-001' } },
      { ok: false, status: 503 },
    )
    await expect(makeService().onboardSeller()).rejects.toThrow('createBalanceAccount failed: 503')
  })
})

// ---------------------------------------------------------------------------
// getKycStatus
// ---------------------------------------------------------------------------

describe('AdyenPayoutService.getKycStatus', () => {
  it('returns KYC_VERIFIED when verification.status is "valid"', async () => {
    mockFetch({ ok: true, body: { verification: { status: 'valid' } } })
    expect(await makeService().getKycStatus('ah-001')).toBe(KycStatus.KYC_VERIFIED)
  })

  it('returns KYC_FAILED when verification.status is "invalid"', async () => {
    mockFetch({ ok: true, body: { verification: { status: 'invalid' } } })
    expect(await makeService().getKycStatus('ah-001')).toBe(KycStatus.KYC_FAILED)
  })

  it('returns PENDING when verification.status is "awaiting_data"', async () => {
    mockFetch({ ok: true, body: { verification: { status: 'awaiting_data' } } })
    expect(await makeService().getKycStatus('ah-001')).toBe(KycStatus.PENDING)
  })

  it('returns PENDING when verification is missing entirely', async () => {
    mockFetch({ ok: true, body: {} })
    expect(await makeService().getKycStatus('ah-001')).toBe(KycStatus.PENDING)
  })

  it('throws when the Adyen call fails', async () => {
    mockFetch({ ok: false, status: 404 })
    await expect(makeService().getKycStatus('ah-001')).rejects.toThrow('getAccountHolder failed: 404')
  })
})

// ---------------------------------------------------------------------------
// initiateCapture
// ---------------------------------------------------------------------------

describe('AdyenPayoutService.initiateCapture', () => {
  const BASE_PARAMS = {
    buyerPaymentReference: 'order-ref-001',
    amountValue: 10000,      // $100.00
    amountCurrency: 'USD',
    balanceAccountId: 'ba-001',
    commissionBps: 1500,     // 15%
    merchantAccount: 'VividSeatsECOM',
  }

  it('returns captureId and status from Adyen on success', async () => {
    mockFetch({ ok: true, body: { id: 'cap-001', status: 'received' } })
    const result = await makeService().initiateCapture(BASE_PARAMS)
    expect(result).toEqual({ captureId: 'cap-001', status: 'received' })
  })

  it('sends correct split: 15% commission + 85% to seller balance account', async () => {
    mockFetch({ ok: true, body: { id: 'cap-001', status: 'received' } })
    await makeService().initiateCapture(BASE_PARAMS)

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    const commission = body.splits.find((s: { type: string }) => s.type === 'Commission')
    const seller = body.splits.find((s: { type: string }) => s.type === 'BalanceAccount')

    expect(commission.amount.value).toBe(1500) // 15% of 10000
    expect(seller.amount.value).toBe(8500)     // 85%
    expect(seller.account).toBe('ba-001')
  })

  it('rounds commission correctly for fractional cents', async () => {
    mockFetch({ ok: true, body: { id: 'cap-002', status: 'received' } })
    // $10.01 at 15% = 150.15 cents → rounds to 150
    await makeService().initiateCapture({ ...BASE_PARAMS, amountValue: 1001 })
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    const commission = body.splits.find((s: { type: string }) => s.type === 'Commission')
    expect(commission.amount.value).toBe(150)
    expect(body.splits.find((s: { type: string }) => s.type === 'BalanceAccount').amount.value).toBe(851)
  })

  it('throws when capture call fails', async () => {
    mockFetch({ ok: false, status: 422 })
    await expect(makeService().initiateCapture(BASE_PARAMS)).rejects.toThrow('initiateCapture failed: 422')
  })
})

// ---------------------------------------------------------------------------
// releasePayout — happy path + retry logic
// ---------------------------------------------------------------------------

describe('AdyenPayoutService.releasePayout', () => {
  const BASE_PARAMS = {
    balanceAccountId: 'ba-001',
    paymentInstrumentId: 'pi-001',
    amountValue: 8500,
    amountCurrency: 'USD',
    reference: 'listing-001',
  }

  it('returns transferId and status from Adyen on first attempt', async () => {
    mockFetch({ ok: true, body: { id: 'tr-001', status: 'initiated' } })
    const result = await makeService().releasePayout(BASE_PARAMS)
    expect(result).toEqual({ transferId: 'tr-001', status: 'initiated' })

    const fetchMock = global.fetch as jest.Mock
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.type).toBe('payout')
    expect(body.balanceAccountId).toBe('ba-001')
    expect(body.paymentInstrumentId).toBe('pi-001')
  })

  it('retries on failure and succeeds on the 2nd attempt', async () => {
    mockFetch(
      { ok: false, status: 503 },
      { ok: true, body: { id: 'tr-002', status: 'initiated' } },
    )
    const result = await makeService().releasePayout(BASE_PARAMS)
    expect(result.transferId).toBe('tr-002')
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(2)
  })

  it('retries up to 3 times then throws', async () => {
    mockFetch(
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    )
    await expect(makeService().releasePayout(BASE_PARAMS)).rejects.toThrow('releasePayout failed: 503')
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(3)
  })

  it('does not make a 4th attempt', async () => {
    mockFetch(
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: true, body: { id: 'should-not-reach', status: 'initiated' } },
    )
    await expect(makeService().releasePayout(BASE_PARAMS)).rejects.toThrow()
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(3)
  })
})
