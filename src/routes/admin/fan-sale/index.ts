// MKPLS-362 + MKPLS-388: Admin routes for fan sale management
// All routes require admin JWT role (enforced by requireAdmin preHandler).

import { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../../../middleware/requireAdmin'
import { unsuspendHandler } from './handlers/unsuspend'

export const adminFanSaleRoutes: FastifyPluginAsync = async (app) => {
  // requireAdmin verifies JWT and checks role === 'admin'
  app.addHook('preHandler', requireAdmin)

  // MKPLS-388: clear suspension and write audit trail
  app.post('/admin/fan-sale/sellers/:sellerId/unsuspend', unsuspendHandler)
}
