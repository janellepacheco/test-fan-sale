// Populate required env vars before any module (including env.ts) is imported.
// Mirrors values from .env.example; never real credentials.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/fan_sale_test'
process.env.AUTH_JWT_SECRET = 'test-secret-minimum-sixteen-chars'
process.env.FAN_SALE_ENABLED = 'true'
process.env.HERMES_SERVICE_URL = 'http://hermes-mock'
process.env.ADYEN_API_KEY = 'test-adyen-api-key'
process.env.ADYEN_BALANCE_PLATFORM = 'test-balance-platform-id'
// 32-byte hex key used by adyen-webhook.test.ts to generate valid HMAC signatures
process.env.ADYEN_WEBHOOK_HMAC_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
