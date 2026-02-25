// Shared listing utilities — used by list, get, create, update, delist, and fulfill handlers.

import type { FanListing } from '@prisma/client'
import { ListingResponse, FanListingStatus, TicketSource } from '../types'

export const DEFAULT_FEE_PERCENT = 0.15

export function computeEstimatedPayout(askingPrice: number, feePercent = DEFAULT_FEE_PERCENT): number {
  return +(askingPrice * (1 - feePercent)).toFixed(2)
}

function toNum(v: { toNumber(): number } | number): number {
  return typeof v === 'number' ? v : v.toNumber()
}

export function toListingResponse(listing: FanListing): ListingResponse {
  const askingPrice = toNum(listing.askingPrice)
  const feePercent = toNum(listing.feePercent)
  return {
    id: listing.id,
    sellerId: listing.sellerId,
    orderId: listing.orderId,
    ticketId: listing.ticketId,
    ticketSource: (listing.ticketSource as TicketSource) ?? TicketSource.OTHER,
    eventId: listing.eventId,
    section: listing.section,
    row: listing.row,
    seatNumber: listing.seatNumber,
    askingPrice,
    estimatedPayout: computeEstimatedPayout(askingPrice, feePercent),
    status: listing.status as FanListingStatus,
    createdAt: listing.createdAt.toISOString(),
    expiresAt: listing.expiresAt.toISOString(),
  }
}
