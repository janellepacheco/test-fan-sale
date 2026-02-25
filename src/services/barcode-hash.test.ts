// MKPLS-386: barcode hash service unit tests

import { generateBarcodeHash } from './barcode-hash'

describe('generateBarcodeHash', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = generateBarcodeHash('ticket-001', ['5'])
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic — same inputs produce same hash', () => {
    const a = generateBarcodeHash('ticket-001', ['5'])
    const b = generateBarcodeHash('ticket-001', ['5'])
    expect(a).toBe(b)
  })

  it('sorts seat numbers before hashing — order-independent', () => {
    const a = generateBarcodeHash('ticket-001', ['5', '6'])
    const b = generateBarcodeHash('ticket-001', ['6', '5'])
    expect(a).toBe(b)
  })

  it('produces different hashes for different ticketIds', () => {
    const a = generateBarcodeHash('ticket-001', ['5'])
    const b = generateBarcodeHash('ticket-002', ['5'])
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different seat numbers', () => {
    const a = generateBarcodeHash('ticket-001', ['5'])
    const b = generateBarcodeHash('ticket-001', ['6'])
    expect(a).not.toBe(b)
  })

  it('handles empty seat numbers array', () => {
    const hash = generateBarcodeHash('ticket-001', [])
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not mutate the input array when sorting', () => {
    const seats = ['6', '5']
    generateBarcodeHash('ticket-001', seats)
    expect(seats).toEqual(['6', '5'])
  })
})
