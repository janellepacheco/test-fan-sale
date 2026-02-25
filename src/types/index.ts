// MKPLS-342: Shared TypeScript types for the Fan Sale service
// These are the canonical types consumed by routes, middleware, and services.

// MKPLS-370: rawBody is added to requests processed by the scoped content-type
// parser in the webhook child plugin. Routes outside that scope get undefined.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

// ---------------------------------------------------------------------------
// Auth
// Mirrors the AuthCookie shape from vivid-web-athena (src/middlewares/withAuthenticatedUser.ts)
// ---------------------------------------------------------------------------

export interface AuthToken {
  token: string
  accountId: number
  brokerId?: number
  refreshToken: string
  tokenExpiresAt: number
}

// Attached to FastifyRequest after authenticate() runs
export interface AuthenticatedUser {
  accountId: number
  brokerId?: number
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// Ticket source values — all platforms whose tickets are eligible.
// Source is captured for analytics ONLY — it is NOT an eligibility criterion.
export enum TicketSource {
  VIVID_SEATS = 'vivid_seats',
  STUBHUB = 'stubhub',
  SEATGEEK = 'seatgeek',
  TICKETMASTER = 'ticketmaster',
  AXS = 'axs',
  OTHER = 'other',
}

export enum FanListingStatus {
  ACTIVE = 'ACTIVE',
  SOLD = 'SOLD',
  DELISTED = 'DELISTED',
  EXPIRED = 'EXPIRED',
  FULFILLED = 'FULFILLED',
}

export enum FulfillmentStatus {
  PENDING = 'PENDING',
  FULFILLED = 'FULFILLED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

export enum KycStatus {
  PENDING = 'PENDING',
  KYC_VERIFIED = 'KYC_VERIFIED',
  KYC_FAILED = 'KYC_FAILED',
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  INITIATED = 'INITIATED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// ---------------------------------------------------------------------------
// MKPLS-346: GET /orders/:id/eligible-tickets
// ---------------------------------------------------------------------------

export interface EligibleTicket {
  ticketId: string
  seatNumber: string
  section: string
  row: string
  eventId: string
  eventName: string
  eventDate: string       // ISO 8601
  ticketSource: TicketSource
}

export interface EligibleTicketsResponse {
  orderId: string
  eligible: EligibleTicket[]
}

// ---------------------------------------------------------------------------
// MKPLS-347: POST /fan-sale/listings
// ---------------------------------------------------------------------------

export interface CreateListingBody {
  orderId: string
  ticketId: string
  askingPrice: number     // in USD, e.g. 49.99
}

export interface ListingResponse {
  id: string
  sellerId: number
  orderId: string
  ticketId: string
  ticketSource: TicketSource
  eventId: string
  section: string
  row: string
  seatNumber: string
  askingPrice: number
  estimatedPayout: number // askingPrice * (1 - feePercent)
  status: FanListingStatus
  createdAt: string
  expiresAt: string
}

// ---------------------------------------------------------------------------
// MKPLS-358: PATCH /fan-sale/listings/:id
// ---------------------------------------------------------------------------

export interface UpdateListingBody {
  askingPrice: number
}

// ---------------------------------------------------------------------------
// MKPLS-353: GET /fan-sale/price-comps
// ---------------------------------------------------------------------------

export interface PriceCompsQuery {
  eventId: string
  section?: string
}

export interface PriceComp {
  listingId: string
  section: string
  row: string
  askingPrice: number
  quantity: number
}

export interface PriceCompsResponse {
  eventId: string
  comps: PriceComp[]
  suggestedPrice: number  // median of comps
  minPrice: number
  maxPrice: number
}

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string
  message: string
  statusCode: number
}
