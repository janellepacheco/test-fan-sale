// Shared listing utilities — used by create, update, delist, and read handlers.

import { FanListingStatus, ListingResponse, TicketSource } from '../types'

export const DEFAULT_FEE_PERCENT = 0.15

export function computeEstimatedPayout(
  askingPrice: number,
  feePercent: number = DEFAULT_FEE_PERCENT,
): number {
  return +(askingPrice * (1 - feePercent)).toFixed(2)
}

function normaliseSource(raw: string): TicketSource {
  const known = Object.values(TicketSource) as string[]
  return known.includes(raw) ? (raw as TicketSource) : TicketSource.OTHER
}

export function toListingResponse(listing: {
  id: string
  sellerId: number
  orderId: string
  ticketId: string
  ticketSource: string
  eventId: string
  section: string
  row: string
  seatNumber: string
  askingPrice: { toNumber(): number } | number
  feePercent: { toNumber(): number } | number
  status: string
  createdAt: Date
  expiresAt: Date
}): ListingResponse {
  const askingPrice =
    typeof listing.askingPrice === 'number' ? listing.askingPrice : listing.askingPrice.toNumber()
  const feePercent =
    typeof listing.feePercent === 'number' ? listing.feePercent : listing.feePercent.toNumber()

  return {
    id: listing.id,
    sellerId: listing.sellerId,
    orderId: listing.orderId,
    ticketId: listing.ticketId,
    ticketSource: normaliseSource(listing.ticketSource),
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
