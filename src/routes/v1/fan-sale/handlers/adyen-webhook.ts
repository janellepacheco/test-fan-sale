// MKPLS-370: POST /v1/fan-sale/webhooks/adyen
//
// Receives Balance Platform configuration webhooks from Adyen.
// Security: HMAC-SHA256 over the raw request body; key = ADYEN_WEBHOOK_HMAC_KEY (hex).
// Adyen sends the signature in the lowercase "hmacsignature" header.
//
// Handled event:
//   balancePlatform.accountHolder.updated — KYC / verification status changes
//
// Idempotency:
//   notificationId is recorded in webhook_events; duplicate deliveries are ack'd
//   without re-writing DB state or re-sending seller notifications.

import { FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { env } from '../../../plugins/env'
import { NotificationService } from '../../../services/notifications'

// ---------------------------------------------------------------------------
// HMAC validation (pure — exported for unit tests)
// ---------------------------------------------------------------------------

// Returns true when HMAC-SHA256(key, rawBody) ≡ signature (timing-safe).
// hmacKeyHex is the hex-encoded webhook signing key from ADYEN_WEBHOOK_HMAC_KEY.
export function validateHmac(rawBody: Buffer, signature: string, hmacKeyHex: string): boolean {
  if (!hmacKeyHex || !signature) return false
  try {
    const key = Buffer.from(hmacKeyHex, 'hex')
    const expected = createHmac('sha256', key).update(rawBody).digest('base64')
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)
    // Length guard prevents timing oracle; timingSafeEqual requires equal lengths
    if (sigBuf.length !== expBuf.length) return false
    return timingSafeEqual(sigBuf, expBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Payload schema — Balance Platform accountHolder.updated event
// ---------------------------------------------------------------------------

const WebhookPayloadSchema = z.object({
  notificationId: z.string().min(1),
  type: z.string(),
  data: z.object({
    id: z.string(), // adyenAccountHolderId
    verification: z
      .object({
        status: z.string(), // "valid" | "invalid" | "pending" | ...
      })
      .optional(),
  }),
})

type AdyenVerificationStatus = string

function mapVerificationStatus(status: AdyenVerificationStatus): 'KYC_VERIFIED' | 'KYC_FAILED' | 'PENDING' {
  if (status === 'valid') return 'KYC_VERIFIED'
  if (status === 'invalid') return 'KYC_FAILED'
  return 'PENDING'
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export const makeAdyenWebhookHandler =
  (notificationService: NotificationService) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // --- 1. HMAC validation ---
    const hmacKey = env.ADYEN_WEBHOOK_HMAC_KEY ?? ''
    // Fastify lowercases all incoming header names
    const headerSig = request.headers['hmacsignature'] as string | undefined

    if (
      !headerSig ||
      !hmacKey ||
      !validateHmac((request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0), headerSig, hmacKey)
    ) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing HMAC signature',
        statusCode: 401,
      })
    }

    // --- 2. Parse body ---
    const parsed = WebhookPayloadSchema.safeParse(request.body)
    if (!parsed.success) {
      // Ack malformed events — returning 4xx would cause Adyen to retry forever
      request.log.warn({ body: request.body }, 'Received unparseable Adyen webhook; acknowledging')
      return reply.code(200).send({ received: true })
    }

    const { notificationId, type, data } = parsed.data

    // --- 3. Only handle accountHolder.updated; silently ack everything else ---
    if (type !== 'balancePlatform.accountHolder.updated') {
      request.log.info({ type, notificationId }, 'Ignoring unhandled Adyen event type')
      return reply.code(200).send({ received: true })
    }

    // --- 4. Idempotency check ---
    const alreadyProcessed = await request.server.prisma.webhookEvent.findUnique({
      where: { notificationId },
    })
    if (alreadyProcessed) {
      request.log.info({ notificationId }, 'Duplicate Adyen webhook delivery; acking without reprocessing')
      return reply.code(200).send({ received: true })
    }

    // --- 5. Look up seller by Adyen account holder ID ---
    const account = await request.server.prisma.sellerPaymentAccount.findFirst({
      where: { adyenAccountHolderId: data.id },
    })
    if (!account) {
      // Could be a test event or a race with onboarding — log and ack
      request.log.warn({ accountHolderId: data.id }, 'No seller account found for Adyen account holder; acking')
      return reply.code(200).send({ received: true })
    }

    // --- 6. Map Adyen verification status → KycStatus ---
    const kycStatus = mapVerificationStatus(data.verification?.status ?? 'pending')

    // --- 7. Atomic update: kycStatus + dedup record ---
    await request.server.prisma.$transaction([
      request.server.prisma.sellerPaymentAccount.update({
        where: { id: account.id },
        data: { kycStatus },
      }),
      request.server.prisma.webhookEvent.create({
        data: { notificationId, eventType: type },
      }),
    ])

    // --- 8. Notify seller (fire-and-forget — never fail the webhook ack) ---
    if (kycStatus === 'KYC_VERIFIED') {
      notificationService.sendKycVerified(account.sellerId).catch((err) => {
        request.log.error({ err, sellerId: account.sellerId }, 'Failed to send KYC verified notification')
      })
    } else if (kycStatus === 'KYC_FAILED') {
      notificationService.sendKycFailed(account.sellerId).catch((err) => {
        request.log.error({ err, sellerId: account.sellerId }, 'Failed to send KYC failed notification')
      })
    }

    return reply.code(200).send({ received: true })
  }
