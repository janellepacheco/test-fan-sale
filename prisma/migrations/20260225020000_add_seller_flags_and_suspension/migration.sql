-- MKPLS-364: Add seller_flags table and fanSaleSuspended column
--
-- seller_flags records each violation with a reason string.
-- When a seller accumulates 2+ 'fulfillment_failure' flags the cron sets
-- fanSaleSuspended = true on seller_payment_accounts, blocking future listings.

ALTER TABLE "seller_payment_accounts"
  ADD COLUMN "fanSaleSuspended" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "seller_flags" (
  "id"            TEXT        NOT NULL,
  "sellerId"      INTEGER     NOT NULL,
  "reason"        TEXT        NOT NULL,
  "fulfillmentId" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "seller_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seller_flags_sellerId_idx"        ON "seller_flags"("sellerId");
CREATE INDEX "seller_flags_sellerId_reason_idx" ON "seller_flags"("sellerId", "reason");
