// MKPLS-386: Deterministic barcode hash for listing deduplication.
// Prevents the same physical ticket from being listed twice while ACTIVE.
//
// Hash input: ticketId (proxy for barcode data at listing time) + sorted seat numbers.
// Sorting ensures ["5","6"] and ["6","5"] produce the same hash.

import { createHash } from 'node:crypto'

/**
 * Generates a deterministic SHA-256 hash for ticket deduplication.
 *
 * @param ticketId    - unique ticket identifier (barcode data proxy)
 * @param seatNumbers - seat number(s) for the ticket; sorted before hashing
 */
export function generateBarcodeHash(ticketId: string, seatNumbers: string[]): string {
  const sorted = [...seatNumbers].sort()
  const input = `${ticketId}:${sorted.join(',')}`
  return createHash('sha256').update(input).digest('hex')
}
