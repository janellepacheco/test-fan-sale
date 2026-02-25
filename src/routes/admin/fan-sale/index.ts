// MKPLS-362 + MKPLS-388 + MKPLS-389: Admin routes for fan sale management
// All routes require admin JWT role (enforced by requireAdmin preHandler).

import { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../../../middleware/requireAdmin'
import { auditLogHandler } from './handlers/audit-log'
import { unsuspendHandler } from './handlers/unsuspend'
import { flaggedSellersHandler } from './handlers/flagged-sellers'

export const adminFanSaleRoutes: FastifyPluginAsync = async (app) => {
  // requireAdmin verifies JWT and checks role === 'admin'
  app.addHook('preHandler', requireAdmin)

  // MKPLS-362: full mutation history for a listing (support + fraud investigation)
  app.get('/admin/fan-sale/listings/:id/audit-log', auditLogHandler)

  // MKPLS-388: clear suspension and write audit trail
  app.post('/admin/fan-sale/sellers/:sellerId/unsuspend', unsuspendHandler)

  // MKPLS-389: flagged seller review queue
  app.get('/admin/fan-sale/sellers', flaggedSellersHandler)
}
