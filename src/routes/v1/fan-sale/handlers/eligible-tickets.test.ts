// MKPLS-346: eligible-tickets unit tests
// Tests the pure eligibility logic (filterEligibleTickets, isOrderEligible,
// isTicketEligible) in isolation — no Fastify, no DB, no Hermes I/O.

import {
  filterEligibleTickets,
  isOrderEligible,
  isTicketEligible,
  toEligibleTicket,
} from './eligible-tickets'
import { HermesOrder, HermesTicket } from '../../../../services/hermes'
import { TicketSource } from '../../../../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREE_HOURS_MS = 3 * 60 * 60 * 1000

/** Returns a Date that is `offsetMs` milliseconds from `now`. */
function future(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString()
}

function makeTicket(overrides: Partial<HermesTicket> = {}): HermesTicket {
  const now = new Date()
  return {
    ticketId: 'ticket-1',
    seatNumber: '14',
    section: '101',
    row: 'C',
    eventId: 'evt-abc',
    eventName: 'The Eras Tour',
    eventDate: future(now, THREE_HOURS_MS),
    ticketSource: 'vivid_seats',
    scanned: false,
    used: false,
    ...overrides,
  }
}

function makeOrder(overrides: Partial<HermesOrder> = {}): HermesOrder {
  return {
    orderId: 'order-1',
    accountId: 42,
    status: 'confirmed',
    hasActiveDispute: false,
    sellerSuspended: false,
    tickets: [makeTicket()],
    ...overrides,
  }
}

const EMPTY_ACTIVE_SET = new Set<string>()

// ---------------------------------------------------------------------------
// isOrderEligible
// ---------------------------------------------------------------------------

describe('isOrderEligible', () => {
  it('returns true for a healthy confirmed order', () => {
    expect(isOrderEligible(makeOrder())).toBe(true)
  })

  it('returns false when status is not confirmed', () => {
    expect(isOrderEligible(makeOrder({ status: 'cancelled' }))).toBe(false)
    expect(isOrderEligible(makeOrder({ status: 'pending' }))).toBe(false)
    expect(isOrderEligible(makeOrder({ status: 'refunded' }))).toBe(false)
  })

  it('returns false when there is an active dispute', () => {
    expect(isOrderEligible(makeOrder({ hasActiveDispute: true }))).toBe(false)
  })

  it('returns false when the seller account is suspended', () => {
    expect(isOrderEligible(makeOrder({ sellerSuspended: true }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isTicketEligible
// ---------------------------------------------------------------------------

describe('isTicketEligible', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const THREE_HOURS = 3 * 60 * 60 * 1000
  const ONE_HOUR = 1 * 60 * 60 * 1000
  const TWO_HOURS = 2 * 60 * 60 * 1000

  it('returns true for a fully eligible ticket', () => {
    const ticket = makeTicket({ eventDate: future(now, THREE_HOURS) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(true)
  })

  it('returns false when the ticket has been scanned', () => {
    const ticket = makeTicket({ scanned: true, eventDate: future(now, THREE_HOURS) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(false)
  })

  it('returns false when the ticket has been used', () => {
    const ticket = makeTicket({ used: true, eventDate: future(now, THREE_HOURS) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(false)
  })

  it('returns false when the event is within 2 hours', () => {
    const ticket = makeTicket({ eventDate: future(now, ONE_HOUR) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(false)
  })

  it('returns false when the event is exactly 2 hours away (boundary)', () => {
    const ticket = makeTicket({ eventDate: future(now, TWO_HOURS) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(false)
  })

  it('returns true when the event is just over 2 hours away (boundary + 1 ms)', () => {
    const ticket = makeTicket({ eventDate: future(now, TWO_HOURS + 1) })
    expect(isTicketEligible(ticket, EMPTY_ACTIVE_SET, now)).toBe(true)
  })

  it('returns false when the ticket already has an active listing', () => {
    const ticket = makeTicket({ ticketId: 'ticket-already-listed', eventDate: future(now, THREE_HOURS) })
    const alreadyListed = new Set(['ticket-already-listed'])
    expect(isTicketEligible(ticket, alreadyListed, now)).toBe(false)
  })

  it('returns true when a different ticket is listed (no cross-contamination)', () => {
    const ticket = makeTicket({ ticketId: 'ticket-mine', eventDate: future(now, THREE_HOURS) })
    const alreadyListed = new Set(['ticket-someone-elses'])
    expect(isTicketEligible(ticket, alreadyListed, now)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// toEligibleTicket — ticketSource normalisation
// ---------------------------------------------------------------------------

describe('toEligibleTicket', () => {
  it.each([
    ['vivid_seats', TicketSource.VIVID_SEATS],
    ['stubhub', TicketSource.STUBHUB],
    ['seatgeek', TicketSource.SEATGEEK],
    ['ticketmaster', TicketSource.TICKETMASTER],
    ['axs', TicketSource.AXS],
    ['other', TicketSource.OTHER],
  ])('maps ticket source "%s" to TicketSource.%s', (raw, expected) => {
    const result = toEligibleTicket(makeTicket({ ticketSource: raw }))
    expect(result.ticketSource).toBe(expected)
  })

  it('maps unknown ticket source to TicketSource.OTHER', () => {
    const result = toEligibleTicket(makeTicket({ ticketSource: 'venue_direct' }))
    expect(result.ticketSource).toBe(TicketSource.OTHER)
  })
})

// ---------------------------------------------------------------------------
// filterEligibleTickets — integration of all rules
// ---------------------------------------------------------------------------

describe('filterEligibleTickets', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const THREE_HOURS = 3 * 60 * 60 * 1000

  it('returns all tickets when every rule passes', () => {
    const order = makeOrder({
      tickets: [
        makeTicket({ ticketId: 't1', eventDate: future(now, THREE_HOURS) }),
        makeTicket({ ticketId: 't2', eventDate: future(now, THREE_HOURS) }),
      ],
    })
    const result = filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)
    expect(result).toHaveLength(2)
  })

  it('returns empty array when order status is not confirmed', () => {
    const order = makeOrder({ status: 'cancelled' })
    expect(filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)).toEqual([])
  })

  it('returns empty array when order has an active dispute', () => {
    const order = makeOrder({ hasActiveDispute: true })
    expect(filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)).toEqual([])
  })

  it('returns empty array when seller is suspended', () => {
    const order = makeOrder({ sellerSuspended: true })
    expect(filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)).toEqual([])
  })

  it('excludes a scanned ticket while keeping others', () => {
    const order = makeOrder({
      tickets: [
        makeTicket({ ticketId: 't1', scanned: false, eventDate: future(now, THREE_HOURS) }),
        makeTicket({ ticketId: 't2', scanned: true, eventDate: future(now, THREE_HOURS) }),
      ],
    })
    const result = filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)
    expect(result).toHaveLength(1)
    expect(result[0].ticketId).toBe('t1')
  })

  it('excludes a ticket that is already actively listed', () => {
    const order = makeOrder({
      tickets: [
        makeTicket({ ticketId: 't1', eventDate: future(now, THREE_HOURS) }),
        makeTicket({ ticketId: 't2', eventDate: future(now, THREE_HOURS) }),
      ],
    })
    const alreadyListed = new Set(['t2'])
    const result = filterEligibleTickets(order, alreadyListed, now)
    expect(result).toHaveLength(1)
    expect(result[0].ticketId).toBe('t1')
  })

  it('returns an empty array when all tickets fail individually', () => {
    const order = makeOrder({
      tickets: [
        makeTicket({ ticketId: 't1', scanned: true, eventDate: future(now, THREE_HOURS) }),
        makeTicket({ ticketId: 't2', used: true, eventDate: future(now, THREE_HOURS) }),
      ],
    })
    expect(filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // MKPLS-346 requirement: cross-platform tickets must pass
  // ---------------------------------------------------------------------------

  it.each([
    'vivid_seats',
    'stubhub',
    'seatgeek',
    'ticketmaster',
    'axs',
    'other',
    'venue_direct',      // unknown → normalised to OTHER, still eligible
  ])('includes a %s ticket when all other rules pass', (source) => {
    const order = makeOrder({
      tickets: [makeTicket({ ticketSource: source, eventDate: future(now, THREE_HOURS) })],
    })
    const result = filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)
    expect(result).toHaveLength(1)
    expect(result[0].ticketSource).toBeDefined()
  })

  it('mixed order: one VS ticket + one StubHub ticket, both eligible', () => {
    const order = makeOrder({
      tickets: [
        makeTicket({ ticketId: 'vs-1', ticketSource: 'vivid_seats', eventDate: future(now, THREE_HOURS) }),
        makeTicket({ ticketId: 'sh-1', ticketSource: 'stubhub', eventDate: future(now, THREE_HOURS) }),
      ],
    })
    const result = filterEligibleTickets(order, EMPTY_ACTIVE_SET, now)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.ticketSource)).toEqual([
      TicketSource.VIVID_SEATS,
      TicketSource.STUBHUB,
    ])
  })
})
