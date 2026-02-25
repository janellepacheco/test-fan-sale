-- MKPLS-386: Replace full unique constraint with partial unique index
-- Enforces uniqueness only for ACTIVE listings — allows re-listing after delist

-- Drop the full unique constraint added by Prisma @unique (if it exists)
DROP INDEX IF EXISTS "fan_listings_barcodeHash_key";

-- Partial unique index: same barcode cannot be ACTIVE twice,
-- but can be re-listed once the previous listing is DELISTED/SOLD/etc.
CREATE UNIQUE INDEX "fan_listings_barcode_hash_active_idx"
    ON "fan_listings"("barcodeHash")
    WHERE "status" = 'ACTIVE';
