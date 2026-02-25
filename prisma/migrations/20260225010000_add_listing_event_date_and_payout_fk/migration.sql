-- MKPLS-371: Add eventDate to fan_listings and FK from payouts to fan_listings
--
-- eventDate is required by the payout-release cron to enforce the 48h post-event
-- hold window before releasing seller payouts.
--
-- The FK from payouts.listingId → fan_listings.id ensures referential integrity
-- and enables the Prisma relation filter used by the cron query.

ALTER TABLE "fan_listings"
  ADD COLUMN "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Remove DEFAULT after backfill — new rows must supply eventDate explicitly
ALTER TABLE "fan_listings"
  ALTER COLUMN "eventDate" DROP DEFAULT;

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_listingId_fkey"
  FOREIGN KEY ("listingId")
  REFERENCES "fan_listings"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
