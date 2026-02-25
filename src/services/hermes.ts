// MKPLS-375: HermesClient — fetches broker inventory from the Hermes service
// Used by the event inventory handler to merge broker listings with fan listings.

export interface BrokerListing {
  id: string
  source: 'broker'
  section: string
  row: string
  seatNumber?: string
  quantity: number
  price: number
}

export interface HermesInventoryParams {
  section?: string
  minPrice?: number
  maxPrice?: number
  minQuantity?: number
}

export class HermesClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async getEventInventory(
    eventId: string,
    params: HermesInventoryParams = {},
  ): Promise<BrokerListing[]> {
    const qs = new URLSearchParams()
    if (params.section) qs.set('section', params.section)
    if (params.minPrice !== undefined) qs.set('minPrice', String(params.minPrice))
    if (params.maxPrice !== undefined) qs.set('maxPrice', String(params.maxPrice))
    if (params.minQuantity !== undefined) qs.set('minQuantity', String(params.minQuantity))

    const url = `${this.baseUrl}/v1/inventory/events/${eventId}?${qs}`
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } })

    if (!res.ok) {
      throw new Error(`HermesClient.getEventInventory failed: ${res.status}`)
    }

    const body = (await res.json()) as { listings?: BrokerListing[] }
    return (body.listings ?? []).map((l) => ({ ...l, source: 'broker' as const }))
  }
}
