-- MKPLS-368: Add adyenLegalEntityId and onboardingUrl to seller_payment_accounts
-- adyenLegalEntityId: referenced by incoming KYC webhook events (MKPLS-370)
-- onboardingUrl: stored for idempotent re-delivery without re-creating Adyen entities

ALTER TABLE "seller_payment_accounts"
  ADD COLUMN "adyenLegalEntityId" TEXT,
  ADD COLUMN "onboardingUrl" TEXT;
