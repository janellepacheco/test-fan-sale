// MKPLS-346: Hermes BFF client
// Provides order + ticket data used by the eligibility check and other routes.
//
// TODO: replace inline types with generated types from Hermes OpenAPI spec
//       once the spec is published (tracked in MKPLS-341 follow-up).

// ---------------------------------------------------------------------------
// Hermes response shapes
// ---------------------------------------------------------------------------

export interface HermesTicket {
  ticketId: string
  seatNumber: string
  section: string
  row: string
  eventId: string
  eventName: string
  eventDate: string    // ISO 8601 — event start time
  ticketSource: string // any platform: vivid_seats | stubhub | seatgeek | ticketmaster | axs | other
  scanned: boolean
  used: boolean
}

export interface HermesOrder {
  orderId: string
  accountId: number              // VS account that placed the order (ownership check)
  status: 'confirmed' | 'cancelled' | 'pending' | 'refunded'
  hasActiveDispute: boolean      // open dispute or chargeback
  sellerSuspended: boolean       // VS account suspension flag
  tickets: HermesTicket[]
}

// ---------------------------------------------------------------------------
// HermesClient
// ---------------------------------------------------------------------------

export class HermesClient {
  constructor(private readonly baseUrl: string) {}

  async getOrder(orderId: string, bearerToken: string): Promise<HermesOrder | null> {
    const url = `${this.baseUrl}/api/v1/orders/${encodeURIComponent(orderId)}`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (res.status === 404) return null

    if (!res.ok) {
      throw new Error(`Hermes responded ${res.status} for order ${orderId}`)
    }

    return res.json() as Promise<HermesOrder>
  }
}
