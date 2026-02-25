-- MKPLS-375: Add eventDate to fan_listings for inventory 2-hour cutoff rule
-- Fan listings are excluded from inventory results when their event is within
-- 2 hours of start time. expiresAt is used as a proxy for event start date
-- but eventDate is the authoritative field added here.

ALTER TABLE "fan_listings"
  ADD COLUMN "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "fan_listings"
  ALTER COLUMN "eventDate" DROP DEFAULT;
