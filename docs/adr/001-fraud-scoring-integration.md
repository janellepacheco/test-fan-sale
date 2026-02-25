# ADR 001: Async Fraud Scoring Integration at Listing Creation

**Status:** Proposed — pending decision with Trust and Safety
**Ticket:** MKPLS-390
**Date:** 2026-02-25

---

## Context

When a seller creates a Fan Sale listing (`POST /fan-sale/listings`), we need to run a fraud
score against the Trust and Safety (T&S) fraud engine without degrading the response time of
the creation API (target P99 < 300ms). The T&S fraud engine is an existing internal service
that accepts a payload and returns a risk score + recommendation (`allow | review | block`).

---

## Options

### Option A — Synchronous pre-creation check (blocking)

The create handler calls the T&S fraud API before writing to the DB. If the score is `block`,
return 403 and reject the listing. If `review`, create but flag for manual review.

**Pros**
- Simplest control flow — listing is never created if blocked
- No cleanup needed for fraudulent listings

**Cons**
- Adds T&S API latency to every create request (typically 80–150ms p99)
- T&S availability becomes a dependency — any T&S outage blocks all listings
- Requires circuit breaker to fail open (allow listing) when T&S is down

---

### Option B — Async post-creation scoring with auto-delist (recommended)

The create handler writes the listing immediately (responds in < 50ms) and enqueues a fraud
scoring job (e.g., via a database-backed job queue or Redis LPUSH). A worker picks up the job,
calls T&S, and auto-delists (`status = DELISTED`) if the score is `block`. A `review` outcome
flags the listing for admin inspection via the seller review queue (MKPLS-389).

**Pros**
- No latency impact on listing creation — T&S runs out of band
- T&S outage only delays scoring, does not block listing creation
- Scales independently — scoring workers can be scaled separately from the API

**Cons**
- Brief window (~seconds) where a fraudulent listing is technically ACTIVE before scoring
- Requires a job queue and worker infrastructure
- Auto-delist flow needs to notify the seller (use `sendFulfillmentFailed` pattern or a new event)

---

### Option C — Async with provisional status

Listing created with `status = PENDING_REVIEW` rather than `ACTIVE`. Goes live only after T&S
scores it as `allow`. Buyer-facing inventory query filters out `PENDING_REVIEW` listings.

**Pros**
- Fraudulent listings never appear in inventory, even briefly
- Still non-blocking for the seller's create response

**Cons**
- Requires schema change (`PENDING_REVIEW` enum value)
- Sellers may be confused about why their listing isn't visible immediately
- Adds latency to time-to-live for legitimate sellers
- Requires UX change in the listing wizard to show "under review" state

---

## Tradeoffs Summary

| | Response time | Fraud exposure window | T&S dependency | Complexity |
|---|---|---|---|---|
| **A — Sync** | +80–150ms | None | Hard (blocks on outage) | Low |
| **B — Async + auto-delist** | No impact | ~seconds | Soft (outage = delay) | Medium |
| **C — Async + provisional** | No impact | None | Soft (outage = delay) | High |

---

## Recommendation

**Option B** is recommended as the default starting point. The fraud exposure window is
acceptably short for the initial launch (high-value fraud scenarios are mitigated by the
barcode dedup (MKPLS-386) and velocity limit (MKPLS-387) already in place). If T&S scoring
volume or fraud rates indicate a tighter window is needed, Option C can be layered on top
with a schema migration and UI change.

**Decision needs sign-off from:** Trust and Safety team

---

## Follow-up Implementation Tickets (if Option B is chosen)

1. `POST /fan-sale/fraud-score-jobs` internal queue table or Redis LPUSH schema
2. Fraud scoring worker — calls T&S, handles `allow | review | block` outcomes
3. Auto-delist flow on `block` — writes audit log, notifies seller
4. Admin flagged listing queue for `review` outcomes (extension of MKPLS-389)
5. Circuit breaker / dead-letter handling for T&S timeout
