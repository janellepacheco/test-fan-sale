// Sets required env vars before any module (including plugins/env.ts) is imported.
// process.exit(1) in env.ts only fires during the safeParse call at module load time,
// so these must be present before the first require().
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/fan_sale_test'
process.env.AUTH_JWT_SECRET = 'test-secret-minimum-sixteen-chars'
process.env.FAN_SALE_ENABLED = 'true'
process.env.NODE_ENV = 'test'
process.env.HERMES_SERVICE_URL = 'http://hermes-mock'
