-- MKPLS-370: Deduplication table + index for Adyen webhook handling
--
-- webhook_events: prevents duplicate DB writes and double notifications
--   when Adyen retries a delivery that received a non-200.
--
-- INDEX ON seller_payment_accounts.adyenAccountHolderId: the webhook handler
--   looks up a seller by the accountHolderId Adyen sends in the event payload.

CREATE TABLE "webhook_events" (
  "id"             TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "eventType"      TEXT NOT NULL,
  "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_notificationId_key"
  ON "webhook_events"("notificationId");

CREATE INDEX "seller_payment_accounts_adyenAccountHolderId_idx"
  ON "seller_payment_accounts"("adyenAccountHolderId");
