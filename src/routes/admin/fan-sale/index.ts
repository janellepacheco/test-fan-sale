// MKPLS-362: Admin route namespace for Fan Sale
// All routes here require a valid JWT with role: 'admin'.
// Registered at /v1/admin in app.ts.

import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../../middleware/authenticate'
import { requireAdmin } from '../../../middleware/requireAdmin'
import { auditLogHandler } from './handlers/audit-log'

export const adminFanSaleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  // -------------------------------------------------------------------------
  // MKPLS-362: GET /admin/fan-sale/listings/:id/audit-log
  // Full mutation history for a listing — support and fraud investigation.
  // -------------------------------------------------------------------------
  app.get('/admin/fan-sale/listings/:id/audit-log', auditLogHandler)
}
