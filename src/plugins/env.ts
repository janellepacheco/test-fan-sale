import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().min(1),

  // Auth — must match the secret used to sign the 'at' cookie in vivid-web-athena
  AUTH_JWT_SECRET: z.string().min(1),

  // Feature flag — backend gate for the Fan Sale API
  // Paired with the Optimizely fanSaleEnabled flag in vivid-web-athena (MKPLS-340)
  FAN_SALE_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Adyen for Platforms (MKPLS-343, MKPLS-368)
  ADYEN_API_KEY: z.string().optional(),
  ADYEN_MERCHANT_ACCOUNT: z.string().default('VividSeatsECOM'),
  ADYEN_BALANCE_PLATFORM: z.string().optional(),
  ADYEN_WEBHOOK_HMAC_KEY: z.string().optional(),
  ADYEN_ENVIRONMENT: z.enum(['TEST', 'LIVE']).default('TEST'),

  // Internal services
  HERMES_SERVICE_URL: z.string().url().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error(
    '❌ Invalid environment variables:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  )
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env
