-- MKPLS-345: Add payouts table for Adyen payout lifecycle tracking
-- Stores one record per seller payout attempt; transferId is the Adyen transfer ID
-- returned from POST /transfers. Written by AdyenPayoutService.releasePayout
-- and consumed by the payout-release cron (MKPLS-371).

CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'INITIATED', 'COMPLETED', 'FAILED');

CREATE TABLE "payouts" (
  "id"          TEXT        NOT NULL,
  "sellerId"    INTEGER     NOT NULL,
  "listingId"   TEXT        NOT NULL,
  "transferId"  TEXT        UNIQUE,
  "amount"      DECIMAL(10, 2) NOT NULL,
  "status"      "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "initiatedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payouts_sellerId_idx" ON "payouts"("sellerId");
CREATE INDEX "payouts_listingId_idx" ON "payouts"("listingId");
