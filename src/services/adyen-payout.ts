// MKPLS-345: AdyenPayoutService — Adyen for Platforms payout lifecycle
//
// Covers the full seller payout lifecycle using Adyen Balance Platform:
//   onboardSeller   — LegalEntity + AccountHolder + BalanceAccount
//   getKycStatus    — maps Adyen verification.status → our KycStatus enum
//   initiateCapture — split capture: buyer charge → commission + seller net
//   releasePayout   — POST /transfers type:payout with exponential backoff retry
//
// Uses Node 20 native fetch. No Adyen SDK dependency.

import { KycStatus } from '../types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OnboardSellerResult {
  legalEntityId: string
  accountHolderId: string
  balanceAccountId: string
}

export interface InitiateCaptureParams {
  /** VS internal payment reference for the buyer's order */
  buyerPaymentReference: string
  /** Gross charge amount in minor units (e.g. cents) */
  amountValue: number
  amountCurrency: string
  /** Seller's Adyen balance account — receives the net amount */
  balanceAccountId: string
  /** VS commission in basis points, e.g. 1500 = 15 % */
  commissionBps: number
  merchantAccount: string
}

export interface InitiateCaptureResult {
  captureId: string
  status: string
}

export interface ReleasePayoutParams {
  /** Seller's balance account (source of funds) */
  balanceAccountId: string
  /** Seller's registered card/debit instrument (destination) */
  paymentInstrumentId: string
  amountValue: number
  amountCurrency: string
  /** Idempotency reference — typically the listing ID */
  reference: string
}

export interface ReleasePayoutResult {
  transferId: string
  status: string
}

// ---------------------------------------------------------------------------
// Retry helper (exponential back-off)
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < maxAttempts - 1) {
        await new Promise((res) => setTimeout(res, baseDelayMs * 2 ** attempt))
      }
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdyenPayoutService {
  private readonly headers: Record<string, string>
  private readonly lemBaseUrl: string
  private readonly bclBaseUrl: string
  private readonly transfersBaseUrl: string
  /** Exposed for test injection — keeps retry delays near-zero in unit tests */
  private readonly _retryDelayMs: number

  constructor(opts: {
    apiKey: string
    /** URL overrides — point at sandbox or mock server in tests */
    lemBaseUrl?: string
    bclBaseUrl?: string
    transfersBaseUrl?: string
    /** @internal Test-only — sets the exponential-back-off base delay (ms) */
    _retryDelayMs?: number
  }) {
    this.headers = {
      'Content-Type': 'application/json',
      'X-API-Key': opts.apiKey,
    }
    // Default to Adyen TEST environment endpoints
    this.lemBaseUrl =
      opts.lemBaseUrl ?? 'https://balanceplatform-api-test.adyen.com/lem/v3'
    this.bclBaseUrl =
      opts.bclBaseUrl ?? 'https://balanceplatform-api-test.adyen.com/bcl/v2'
    this.transfersBaseUrl =
      opts.transfersBaseUrl ?? 'https://balanceplatform-api-test.adyen.com/btl/v4'
    this._retryDelayMs = opts._retryDelayMs ?? 200
  }

  // -------------------------------------------------------------------------
  // onboardSeller
  // Creates a LegalEntity, then an AccountHolder, then a BalanceAccount.
  // The caller persists the returned IDs to seller_payment_accounts.
  // -------------------------------------------------------------------------
  async onboardSeller(): Promise<OnboardSellerResult> {
    // 1. Legal entity
    const leRes = await fetch(`${this.lemBaseUrl}/legalEntities`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ type: 'individual' }),
    })
    if (!leRes.ok) throw new Error(`createLegalEntity failed: ${leRes.status}`)
    const le = (await leRes.json()) as { id: string }

    // 2. Account holder
    const ahRes = await fetch(`${this.bclBaseUrl}/accountHolders`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ legalEntityId: le.id }),
    })
    if (!ahRes.ok) throw new Error(`createAccountHolder failed: ${ahRes.status}`)
    const ah = (await ahRes.json()) as { id: string }

    // 3. Balance account
    const baRes = await fetch(`${this.bclBaseUrl}/balanceAccounts`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ accountHolderId: ah.id }),
    })
    if (!baRes.ok) throw new Error(`createBalanceAccount failed: ${baRes.status}`)
    const ba = (await baRes.json()) as { id: string }

    return {
      legalEntityId: le.id,
      accountHolderId: ah.id,
      balanceAccountId: ba.id,
    }
  }

  // -------------------------------------------------------------------------
  // getKycStatus
  // Fetches accountHolder from Adyen and maps verification.status:
  //   'valid'   → KYC_VERIFIED
  //   'invalid' → KYC_FAILED
  //   anything  → PENDING
  // -------------------------------------------------------------------------
  async getKycStatus(accountHolderId: string): Promise<KycStatus> {
    const res = await fetch(`${this.bclBaseUrl}/accountHolders/${accountHolderId}`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`getAccountHolder failed: ${res.status}`)
    const body = (await res.json()) as { verification?: { status?: string } }
    const status = body.verification?.status
    if (status === 'valid') return KycStatus.KYC_VERIFIED
    if (status === 'invalid') return KycStatus.KYC_FAILED
    return KycStatus.PENDING
  }

  // -------------------------------------------------------------------------
  // initiateCapture
  // Sends a split capture: gross buyer charge divided into VS commission and
  // net seller credit.  commissionBps (e.g. 1500) drives the split math.
  // -------------------------------------------------------------------------
  async initiateCapture(params: InitiateCaptureParams): Promise<InitiateCaptureResult> {
    const commissionValue = Math.round(params.amountValue * (params.commissionBps / 10000))
    const sellerValue = params.amountValue - commissionValue

    const payload = {
      merchantAccount: params.merchantAccount,
      amount: { value: params.amountValue, currency: params.amountCurrency },
      reference: params.buyerPaymentReference,
      splits: [
        {
          amount: { value: commissionValue, currency: params.amountCurrency },
          type: 'Commission',
        },
        {
          amount: { value: sellerValue, currency: params.amountCurrency },
          type: 'BalanceAccount',
          account: params.balanceAccountId,
        },
      ],
    }

    const res = await fetch(`${this.bclBaseUrl}/captures`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`initiateCapture failed: ${res.status}`)
    const body = (await res.json()) as { id: string; status: string }
    return { captureId: body.id, status: body.status }
  }

  // -------------------------------------------------------------------------
  // releasePayout
  // POSTs to Adyen Transfers API (type: payout) — funds move from the seller's
  // balance account to their registered card.  Retries up to 3× on failure
  // with exponential back-off (200 ms base by default).
  // -------------------------------------------------------------------------
  async releasePayout(params: ReleasePayoutParams): Promise<ReleasePayoutResult> {
    return withRetry(
      async () => {
        const payload = {
          type: 'payout',
          amount: { value: params.amountValue, currency: params.amountCurrency },
          balanceAccountId: params.balanceAccountId,
          paymentInstrumentId: params.paymentInstrumentId,
          reference: params.reference,
        }

        const res = await fetch(`${this.transfersBaseUrl}/transfers`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`releasePayout failed: ${res.status}`)
        const body = (await res.json()) as { id: string; status: string }
        return { transferId: body.id, status: body.status }
      },
      3,
      this._retryDelayMs,
    )
  }
}
