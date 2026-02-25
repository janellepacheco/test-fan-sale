// MKPLS-368: POST /v1/fan-sale/payout/onboard
//
// Starts Adyen Balance Platform onboarding for a seller:
//   1. Create a Legal Entity (LEM v3)
//   2. Create an Account Holder (BCL v2) linked to the legal entity
//   3. Create a Balance Account (BCL v2) — the payout target
//   4. Generate a hosted onboarding URL and return it to the seller
//
// Idempotency:
//   • If the seller already has a PENDING account with a stored URL → 200, return the URL
//   • If KYC_VERIFIED → 409, no further action needed
//   • If KYC_FAILED   → allow re-onboard; overwrites the existing record

import { FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { AdyenBalancePlatformClient } from '../../../services/adyen'

const OnboardBodySchema = z.object({
  // Only 'adyen' is supported; braintree was cancelled (architectural decision 2026-02-24)
  provider: z.literal('adyen', {
    errorMap: () => ({ message: "Only 'adyen' provider is supported" }),
  }),
})

export type OnboardBody = z.infer<typeof OnboardBodySchema>

export interface OnboardResponse {
  onboardingUrl: string
  status: 'PENDING'
}

export const makeOnboardHandler =
  (adyenClient: AdyenBalancePlatformClient) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<OnboardResponse> => {
    // --- 1. Validate body ---
    const parsed = OnboardBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: parsed.error.errors[0]?.message ?? 'Invalid request body',
        statusCode: 400,
      })
    }

    const { accountId: sellerId } = request.user as { accountId: number }

    // --- 2. Idempotency / status gate ---
    const existing = await request.server.prisma.sellerPaymentAccount.findUnique({
      where: { sellerId },
    })

    if (existing) {
      if (existing.kycStatus === 'KYC_VERIFIED') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Seller is already KYC verified',
          statusCode: 409,
        })
      }

      // PENDING: return existing URL without touching Adyen
      if (existing.kycStatus === 'PENDING' && existing.onboardingUrl) {
        reply.code(200)
        return { onboardingUrl: existing.onboardingUrl, status: 'PENDING' }
      }

      // KYC_FAILED falls through to re-onboard
    }

    // --- 3. Create Adyen entities ---
    let legalEntityId: string
    let accountHolderId: string
    let balanceAccountId: string
    let onboardingUrl: string

    try {
      ;({ legalEntityId } = await adyenClient.createLegalEntity())
      ;({ accountHolderId } = await adyenClient.createAccountHolder(legalEntityId))
      ;({ balanceAccountId } = await adyenClient.createBalanceAccount(accountHolderId))
      ;({ url: onboardingUrl } = await adyenClient.getOnboardingUrl(accountHolderId))
    } catch (err) {
      request.log.error({ err, sellerId }, 'Adyen onboarding API call failed')
      return reply.code(502).send({
        error: 'Bad Gateway',
        message: 'Failed to reach Adyen onboarding API',
        statusCode: 502,
      })
    }

    // --- 4. Persist (upsert so KYC_FAILED re-onboards cleanly) ---
    await request.server.prisma.sellerPaymentAccount.upsert({
      where: { sellerId },
      create: {
        sellerId,
        adyenLegalEntityId: legalEntityId,
        adyenAccountHolderId: accountHolderId,
        adyenBalanceAccountId: balanceAccountId,
        onboardingUrl,
        kycStatus: 'PENDING',
      },
      update: {
        adyenLegalEntityId: legalEntityId,
        adyenAccountHolderId: accountHolderId,
        adyenBalanceAccountId: balanceAccountId,
        onboardingUrl,
        kycStatus: 'PENDING',
      },
    })

    reply.code(201)
    return { onboardingUrl, status: 'PENDING' }
  }
