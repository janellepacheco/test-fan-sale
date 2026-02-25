// MKPLS-375 + MKPLS-378: Public inventory routes
// No seller auth — this is a buyer-facing API.

import { FastifyPluginAsync } from 'fastify'
import { makeDefaultEventInventoryHandler } from './handlers/event-inventory'

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // MKPLS-375 + MKPLS-378: GET /inventory/events/:eventId
  // Unified fan + broker listing inventory for an event.
  // Optional source filter (fan | broker) added by MKPLS-378.
  // -------------------------------------------------------------------------
  app.get('/inventory/events/:eventId', makeDefaultEventInventoryHandler())
}
