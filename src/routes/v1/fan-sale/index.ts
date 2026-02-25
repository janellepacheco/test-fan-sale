// Fan Sale route namespace — fully merged (all MKPLS-338 child tickets)
//
// Routes are split into two scoped child plugins so that the Adyen webhook
// (HMAC-secured) is never gated behind the JWT preHandler:
//
//   ┌─ fanSaleRoutes (prefix /v1) ─────────────────────────────────────────┐
//   │  ┌─ webhookScope ───────────────────────────────────────────────────┐ │
//   │  │  POST /fan-sale/webhooks/adyen  (HMAC-SHA256, no JWT)           │ │
//   │  │  addContentTypeParser: captures rawBody for HMAC validation      │ │
//   │  └──────────────────────────────────────────────────────────────────┘ │
//   │  ┌─ authScope ──────────────────────────────────────────────────────┐ │
//   │  │  preHandler: requireFanSaleEnabled + authenticate                │ │
//   │  │  … all seller-facing routes …                                    │ │
//   │  └──────────────────────────────────────────────────────────────────┘ │
//   └──────────────────────────────────────────────────────────────────────┘

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireFanSaleEnabled } from '../../../middleware/featureFlag'
import { requireNotSuspended } from '../../../middleware/requireNotSuspended'
import { checkBarcodeDedup } from '../../../middleware/checkBarcodeDedup'
import { checkListingCap } from '../../../middleware/checkListingCap'
import { rateLimitMiddleware } from '../../../middleware/rateLimit'
import { HermesClient } from '../../../services/hermes'
import { AdyenBalancePlatformClient } from '../../../services/adyen'
import { StubNotificationService } from '../../../services/notifications'
import { env } from '../../../plugins/env'

// Handlers
import { makeEligibleTicketsHandler } from './handlers/eligible-tickets'
import { makeCreateListingHandler } from './handlers/create-listing'
import { listingsHandler, getListingHandler } from './handlers/listings'
import { updateListingHandler } from './handlers/update-listing'
import { delistHandler } from './handlers/delist'
import { makeFulfillHandler } from './handlers/fulfill'
import { priceCompsHandler } from './handlers/price-comps'
import { makeOnboardHandler } from './handlers/onboard'
import { makeAdyenWebhookHandler } from './handlers/adyen-webhook'

export const fanSaleRoutes: FastifyPluginAsync = async (app) => {
  // ── Shared service instances ──────────────────────────────────────────────
  const hermesClient = env.HERMES_SERVICE_URL
    ? new HermesClient(env.HERMES_SERVICE_URL)
    : null

  const adyenClient = new AdyenBalancePlatformClient({
    apiKey: env.ADYEN_API_KEY ?? '',
    balancePlatformId: env.ADYEN_BALANCE_PLATFORM ?? '',
    lemBaseUrl: env.ADYEN_LEM_BASE_URL,
    bclBaseUrl: env.ADYEN_BCL_BASE_URL,
  })

  const notificationService = new StubNotificationService()

  // ── Webhook scope — no JWT auth, raw body capture ─────────────────────────
  // The custom content type parser saves raw bytes so the handler can validate
  // Adyen's HMAC-SHA256 signature before processing the payload.
  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        ;(req as typeof req & { rawBody: Buffer }).rawBody = body
        try {
          done(null, JSON.parse(body.toString()))
        } catch (err) {
          done(err as Error)
        }
      },
    )

    // MKPLS-370: Adyen KYC / account holder status changes
    webhookApp.post('/fan-sale/webhooks/adyen', makeAdyenWebhookHandler(notificationService))
  })

  // ── Authenticated scope — JWT + feature flag on every route ───────────────
  await app.register(async (authApp) => {
    authApp.addHook('preHandler', requireFanSaleEnabled)
    authApp.addHook('preHandler', authenticate)

    // -------------------------------------------------------------------------
    // MKPLS-346: GET /orders/:id/eligible-tickets
    // Returns tickets from the authenticated user's order eligible for Fan Sale.
    // Source is unrestricted — VS, StubHub, TM, AXS, etc.
    // -------------------------------------------------------------------------
    authApp.get(
      '/orders/:id/eligible-tickets',
      makeEligibleTicketsHandler(hermesClient as HermesClient),
    )

    // -------------------------------------------------------------------------
    // MKPLS-347: POST /fan-sale/listings
    // Creates a new fan listing.
    // MKPLS-388: requireNotSuspended — 403 if fanSaleSuspended=true
    // MKPLS-387: checkListingCap — 429 if ≥10 active listings
    // MKPLS-387: rateLimitMiddleware — 429 if >5 creates/hr
    // MKPLS-386: checkBarcodeDedup — 409 if ticket already ACTIVE
    // -------------------------------------------------------------------------
    authApp.post(
      '/fan-sale/listings',
      { preHandler: [requireNotSuspended, checkListingCap, rateLimitMiddleware, checkBarcodeDedup] },
      makeCreateListingHandler(hermesClient),
    )

    // -------------------------------------------------------------------------
    // MKPLS-357: GET /fan-sale/listings
    // Paginated list of listings for the authenticated seller, with status filter.
    // -------------------------------------------------------------------------
    authApp.get('/fan-sale/listings', listingsHandler)

    // -------------------------------------------------------------------------
    // MKPLS-357: GET /fan-sale/listings/:id
    // Single listing by ID. 404 on mismatch or not-owned (no existence leak).
    // -------------------------------------------------------------------------
    authApp.get('/fan-sale/listings/:id', getListingHandler)

    // -------------------------------------------------------------------------
    // MKPLS-358: PATCH /fan-sale/listings/:id
    // Reprice an ACTIVE listing. Writes audit log entry atomically.
    // -------------------------------------------------------------------------
    authApp.patch('/fan-sale/listings/:id', updateListingHandler)

    // -------------------------------------------------------------------------
    // MKPLS-359: DELETE /fan-sale/listings/:id
    // Soft-delist (DELISTED). Audit log written atomically.
    // -------------------------------------------------------------------------
    authApp.delete('/fan-sale/listings/:id', delistHandler)

    // -------------------------------------------------------------------------
    // MKPLS-363: POST /fan-sale/listings/:id/fulfill
    // Seller marks a SOLD listing fulfilled after ticket transfer.
    // -------------------------------------------------------------------------
    authApp.post('/fan-sale/listings/:id/fulfill', makeFulfillHandler(notificationService))

    // -------------------------------------------------------------------------
    // MKPLS-353: GET /fan-sale/price-comps
    // Comparable ACTIVE listings + median/min/max for seller pricing guidance.
    // Redis-cached at 300 s TTL (configurable via PRICE_COMPS_TTL_SECONDS).
    // -------------------------------------------------------------------------
    authApp.get('/fan-sale/price-comps', priceCompsHandler)

    // -------------------------------------------------------------------------
    // MKPLS-368: POST /fan-sale/payout/onboard
    // Initiates Adyen Balance Platform onboarding. Idempotent for PENDING sellers.
    // -------------------------------------------------------------------------
    authApp.post('/fan-sale/payout/onboard', makeOnboardHandler(adyenClient))
  })
}
