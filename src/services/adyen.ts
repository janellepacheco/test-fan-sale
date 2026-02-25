// MKPLS-368: Adyen Balance Platform API client
// Wraps:
//   • Legal Entity Management API (LEM v3)  — legalEntities
//   • Balance Platform Control API (BCL v2) — accountHolders, balanceAccounts,
//                                             hostedOnboarding/linkTokens
//
// Auth: X-API-Key header (API key from ADYEN_API_KEY env var)
// All methods throw on non-2xx so callers can catch and return 502.

export interface AdyenLegalEntityResult {
  legalEntityId: string
}

export interface AdyenAccountHolderResult {
  accountHolderId: string
}

export interface AdyenBalanceAccountResult {
  balanceAccountId: string
}

export interface AdyenOnboardingUrlResult {
  url: string
}

export class AdyenBalancePlatformClient {
  private readonly apiKey: string
  private readonly balancePlatformId: string
  private readonly lemBaseUrl: string
  private readonly bclBaseUrl: string

  constructor(opts: {
    apiKey: string
    balancePlatformId: string
    lemBaseUrl?: string
    bclBaseUrl?: string
  }) {
    this.apiKey = opts.apiKey
    this.balancePlatformId = opts.balancePlatformId
    this.lemBaseUrl = opts.lemBaseUrl ?? 'https://kyc.adyen.com/lem/v3'
    this.bclBaseUrl = opts.bclBaseUrl ?? 'https://balanceplatform.adyen.com/bcl/v2'
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Adyen API error ${response.status} at ${url}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  // Step 1: Create a Legal Entity (individual) for the seller.
  // Returns the legalEntityId used to link the account holder.
  async createLegalEntity(): Promise<AdyenLegalEntityResult> {
    const data = await this.post<{ id: string }>(`${this.lemBaseUrl}/legalEntities`, {
      type: 'individual',
    })
    return { legalEntityId: data.id }
  }

  // Step 2: Create an Account Holder tied to the legal entity.
  // accountHolderId is the parent for all balance accounts and payouts.
  async createAccountHolder(legalEntityId: string): Promise<AdyenAccountHolderResult> {
    const data = await this.post<{ id: string }>(`${this.bclBaseUrl}/accountHolders`, {
      legalEntityId,
      balancePlatform: this.balancePlatformId,
    })
    return { accountHolderId: data.id }
  }

  // Step 3: Create a Balance Account under the account holder.
  // This is the account that receives seller payouts in USD.
  async createBalanceAccount(accountHolderId: string): Promise<AdyenBalanceAccountResult> {
    const data = await this.post<{ id: string }>(`${this.bclBaseUrl}/balanceAccounts`, {
      accountHolderId,
      defaultCurrencyCode: 'USD',
    })
    return { balanceAccountId: data.id }
  }

  // Step 4: Generate a hosted onboarding URL for the seller.
  // Adyen's hosted UI collects KYC data; the URL is valid for ~7 days.
  async getOnboardingUrl(accountHolderId: string): Promise<AdyenOnboardingUrlResult> {
    const data = await this.post<{ url: string }>(
      `${this.bclBaseUrl}/hostedOnboarding/linkTokens`,
      { accountHolderId },
    )
    return { url: data.url }
  }
}
