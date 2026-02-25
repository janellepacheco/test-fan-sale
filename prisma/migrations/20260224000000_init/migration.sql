-- MKPLS-339: Initial schema migration
-- Generated to match prisma/schema.prisma (fan-sale-service Phase 0)
-- Run with: npx prisma migrate deploy  (CI/prod)
--       or: npx prisma migrate dev     (local dev — also regenerates client)

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "FanListingStatus" AS ENUM (
  'ACTIVE',
  'SOLD',
  'DELISTED',
  'EXPIRED',
  'FULFILLED'
);

CREATE TYPE "FulfillmentStatus" AS ENUM (
  'PENDING',
  'FULFILLED',
  'FAILED',
  'EXPIRED'
);

-- MKPLS-368: KYC driven by Adyen account holder verification
CREATE TYPE "KycStatus" AS ENUM (
  'PENDING',
  'KYC_VERIFIED',
  'KYC_FAILED'
);

-- MKPLS-371: Payout lifecycle tracked separately from listing status
CREATE TYPE "PayoutStatus" AS ENUM (
  'PENDING',
  'INITIATED',
  'COMPLETED',
  'FAILED'
);

-- ---------------------------------------------------------------------------
-- fan_listings
-- MKPLS-339: core listing record
-- ticket_source is analytics-only — eligibility is NOT gated by source
-- barcodeHash (MKPLS-386): SHA-256 of the ticket barcode, unique — prevents
--   the same physical ticket being listed twice across any seller
-- velocity index on (sellerId, status) supports the ≤10 ACTIVE check (MKPLS-387)
-- ---------------------------------------------------------------------------

CREATE TABLE "fan_listings" (
  "id"           TEXT                 NOT NULL,
  "sellerId"     INTEGER              NOT NULL,
  "orderId"      TEXT                 NOT NULL,
  "ticketId"     TEXT                 NOT NULL,
  "ticketSource" TEXT                 NOT NULL DEFAULT 'other',
  "eventId"      TEXT                 NOT NULL,
  "section"      TEXT                 NOT NULL,
  "row"          TEXT                 NOT NULL,
  "seatNumber"   TEXT                 NOT NULL,
  "askingPrice"  DECIMAL(10,2)        NOT NULL,
  "feePercent"   DECIMAL(5,4)         NOT NULL,
  "status"       "FanListingStatus"   NOT NULL DEFAULT 'ACTIVE',
  "barcodeHash"  TEXT,
  "createdAt"    TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)         NOT NULL,
  "expiresAt"    TIMESTAMP(3)         NOT NULL,

  CONSTRAINT "fan_listings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fan_listings_barcodeHash_key"      ON "fan_listings"("barcodeHash");
CREATE INDEX        "fan_listings_sellerId_idx"          ON "fan_listings"("sellerId");
CREATE INDEX        "fan_listings_sellerId_status_idx"   ON "fan_listings"("sellerId", "status");
CREATE INDEX        "fan_listings_eventId_idx"           ON "fan_listings"("eventId");
CREATE INDEX        "fan_listings_status_idx"            ON "fan_listings"("status");

-- ---------------------------------------------------------------------------
-- fulfillments
-- Tracks buyer fulfillment lifecycle after a listing transitions to SOLD.
-- deadlineAt: seller must transfer ticket within this window or status → FAILED.
-- ---------------------------------------------------------------------------

CREATE TABLE "fulfillments" (
  "id"           TEXT                  NOT NULL,
  "listingId"    TEXT                  NOT NULL,
  "buyerOrderId" TEXT                  NOT NULL,
  "status"       "FulfillmentStatus"   NOT NULL DEFAULT 'PENDING',
  "deadlineAt"   TIMESTAMP(3)          NOT NULL,
  "fulfilledAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)          NOT NULL,

  CONSTRAINT "fulfillments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fulfillments_listingId_idx" ON "fulfillments"("listingId");

-- ---------------------------------------------------------------------------
-- listing_audit_logs
-- MKPLS-362: immutable log of every mutation to a listing.
-- action values: "created" | "price_updated" | "delisted" | "sold" | "expired"
-- metadata: JSON diff, e.g. { "oldPrice": 50.00, "newPrice": 45.00 }
-- ---------------------------------------------------------------------------

CREATE TABLE "listing_audit_logs" (
  "id"        TEXT         NOT NULL,
  "listingId" TEXT         NOT NULL,
  "action"    TEXT         NOT NULL,
  "actorId"   INTEGER      NOT NULL,
  "metadata"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "listing_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "listing_audit_logs_listingId_idx" ON "listing_audit_logs"("listingId");

-- ---------------------------------------------------------------------------
-- seller_payment_accounts
-- MKPLS-368: Adyen Balance Platform — one row per seller.
-- adyenAccountHolderId: created via POST /accountHolders
-- adyenBalanceAccountId: child balance account under the holder
-- paymentInstrumentId: seller's stored card registered via /paymentInstruments
-- kycStatus: updated by the Adyen KYC webhook (MKPLS-370)
-- ---------------------------------------------------------------------------

CREATE TABLE "seller_payment_accounts" (
  "id"                    TEXT        NOT NULL,
  "sellerId"              INTEGER     NOT NULL,
  "adyenAccountHolderId"  TEXT,
  "adyenBalanceAccountId" TEXT,
  "paymentInstrumentId"   TEXT,
  "kycStatus"             "KycStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "seller_payment_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_payment_accounts_sellerId_key" ON "seller_payment_accounts"("sellerId");

-- ---------------------------------------------------------------------------
-- payouts
-- MKPLS-371: one payout record per fulfilled listing.
-- transferId: Adyen Transfers API response ID — unique, used for idempotency.
-- amount: net payout = askingPrice × (1 − feePercent), stored at initiation.
-- ---------------------------------------------------------------------------

CREATE TABLE "payouts" (
  "id"          TEXT           NOT NULL,
  "sellerId"    INTEGER        NOT NULL,
  "listingId"   TEXT           NOT NULL,
  "transferId"  TEXT,
  "amount"      DECIMAL(10,2)  NOT NULL,
  "status"      "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "initiatedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)   NOT NULL,

  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payouts_transferId_key"   ON "payouts"("transferId");
CREATE INDEX        "payouts_sellerId_idx"      ON "payouts"("sellerId");
CREATE INDEX        "payouts_listingId_idx"     ON "payouts"("listingId");

-- ---------------------------------------------------------------------------
-- Foreign keys (added after all tables exist)
-- ---------------------------------------------------------------------------

ALTER TABLE "fulfillments"
  ADD CONSTRAINT "fulfillments_listingId_fkey"
  FOREIGN KEY ("listingId")
  REFERENCES "fan_listings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listing_audit_logs"
  ADD CONSTRAINT "listing_audit_logs_listingId_fkey"
  FOREIGN KEY ("listingId")
  REFERENCES "fan_listings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
