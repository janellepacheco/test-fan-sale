-- MKPLS-388: seller suspension on repeated fulfillment failures

-- Add fanSaleSuspended flag to seller_payment_accounts
ALTER TABLE "seller_payment_accounts" ADD COLUMN "fanSaleSuspended" BOOLEAN NOT NULL DEFAULT false;

-- Create seller_flags audit table (shared with MKPLS-364 fulfillment cron)
CREATE TABLE "seller_flags" (
    "id" TEXT NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "actorId" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seller_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seller_flags_sellerId_idx" ON "seller_flags"("sellerId");
CREATE INDEX "seller_flags_sellerId_reason_idx" ON "seller_flags"("sellerId", "reason");
