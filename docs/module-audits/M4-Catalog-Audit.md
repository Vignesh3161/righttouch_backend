# M4 — Catalog (Category / Service / Product / Commission): Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Images: Cloudinary (multer)
> Scope: ONLY M4. Cross-module notes under §27.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M4 is the sellable-catalog: `Category(service|product)` → `Service` (pricing+commission+GST+coveragePolygon+zoneRestricted) / `Product` (pricingModel+estimateRange+GST+quoteRequired+specs) with images via Cloudinary, plus versioned `ServiceCommissionRule` snapshotted immutably at booking. Listing is location-aware (`getAllServices` filters by default-address/GPS + availability; tech hides pricing). The module is straightforward and low-risk; main issues are price/commission snapshot discipline, image lifecycle gaps, unpaginated lists, and admin-only writes relying on scattered guards. Verdict: **YES** — safe to rewrite first (lowest blast radius), keeping snapshot contract frozen for M6/M7/M8.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Category.js` | category+slug, type service\|product, image, isActive | categoryController, service/product create | — | YES | REMAIN |
| `Schemas/Service.js` | categoryId, pricing, commission, discount, GST, content, checklists, isActive, zoneRestricted, coveragePolygon; pre-save auto discount/commission/technicianAmount | serviceController, booking snapshot, matching | Category, CommissionRule | YES (service truth) | REMAIN, freeze snapshot fields |
| `Schemas/Product.js` | pricingModel, estimateRange, GST, quoteRequired, siteInspection, specs, warranty, AMC, FAQs, text index | productController, quote flow | Category | YES | REMAIN |
| `Schemas/ServiceCommissionRule.js` | versioned commission% + effectiveFrom + setBy; latest wins | commission snapshot, adminCommissionController | Service | YES (rule truth) | REMAIN |
| `Controllers/categoryController.js` | create (dup name+type guard), image upload/remove, getAll(byType), getById, update(+slug), delete | Routes/User.js /category* | Category, cloudinary | YES | REMAIN, paginate |
| `Controllers/serviceController.js` | create (validated category+pricing), images add/remove/replace, getAll (location-aware), getById, update, delete, polygon get/set/remove (audited), toggleZoneRestriction | same /service* | Service, Category, availability resolver, AuditLog | YES | REMAIN, split images |
| `Controllers/productController.js` | create (pricing-validated), images, getProduct (search+paginate), getOne, update, delete (blocked if active bookings) | same /product* | Product, ProductBooking | YES | REMAIN |
| `Controllers/adminCommissionController.js` | Rule admin + per-booking override bookkeeping | admin routes | CommissionRule, Booking | YES | REMAIN, version-guard override |
| `Utils/commission.js` | resolveCommissionSnapshot (booking-time immutable) | bookingService, checkout | Service, CommissionRule | YES (keep!) | REMAIN untouched |
| `Utils/productPricing.js`, `Services/quotationPricingService.js` | Product/quote totals server-recalc | quote flow | Product | YES | REMAIN |

No M4 workers/crons; images via `Utils/cloudinaryUpload.js` (multer `upload`).

## 3. Actual Current Flow

```text
Admin: POST /category → POST /service|/product (validated category+pricing) → upload images
 → (service) optionally set coveragePolygon + zoneRestricted toggle → commission rules versioned over time
Customer: GET /getAllServices (default-address or GPS → availability filter; tech pricing hidden)
 → GET /getServiceById/:id → booking/quote (snapshot taken downstream, never live-read later)
Customer: GET /getProduct (text-search + paginate) → GET /getOneProduct/:id → quote request (M7)
Admin: PUT /updateService|/updateProduct/:id → price changes affect FUTURE snapshots only (historical immutable)
```

Failure: invalid category → 400; dup category → 409; delete product with active bookings → blocked; image upload fail → 500/partial. Retry: safe (idempotent creates need client retry with same payload → currently may dup — see §12). Timeout: Cloudinary latency on image paths. Cancel: N/A. Dup/concurrent: category dup-guard racy (§9). Partial: product created but images fail → imageless product (acceptable, retry upload). Admin: commission override path exists (M6/M8 consume).

## 4. Business Rules & Invariants

1. **Catalog is display truth; booking-time snapshot is financial truth — never recompute history from live catalog.** Enforcement: snapshot pattern (good). KEEP + freeze contract + test.
2. **Commission rule latest-wins; bookings pin ruleId+version.** Enforcement: snapshot fields. KEEP.
3. **Products with active bookings cannot be deleted (history preservation).** Enforcement: controller guard. KEEP.
4. **Zone-restricted services sell only where mapped/available.** Enforcement: listing filter + downstream resolver. KEEP (resolver owned M3).
5. **Tech listing hides pricing.** Enforcement: controller branch. KEEP + test (PII-adjacent commercial leak).

## 5. Current Problems

- **P1 — Snapshot discipline undocumented/untested at boundaries (live-price override in book-again; admin override without version guard).** Impact: historical drift risk. Fix: single `pricingService.snapshot()` writer + `calculationVersion` bump + audit on override (override only when payment pending).
- **P2 — Unpaginated `getAllCategory/getAllServices`** (product list has paginate — inconsistent). Fix: paginate all (20/100) with compat.
- **P2 — Image lifecycle: orphan Cloudinary assets on replace/delete failures; no mime/size policy visible.** Fix: allowlist + size cap + delete-old-after-success + orphan sweep note.
- **P2 — Category dup-guard (name+type) racy; no unique index mentioned.** Fix: unique compound + catch → 409.
- **P3 — Scattered `authorizeRoles` per route (works but verbose).** Fix: router-level guard for write subset.
- **P3 — Rupee/paise dual writes on Service price fields.** Fix: paise-only writes going forward (read compat).

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P2 | Pricing hidden from tech — verify no leak via getById/populate | Tech GET service detail | branch hides pricing | commercial leak if missed | test both paths | contract test |
| P2 | Unbounded lists → DoS/memory | GET getAllServices huge catalog | no pagination | slowloris-ish | paginate + cap | load test |
| P2 | Image upload abuse | giant/wrong-type file | multer default? | storage/cost | mime+size + auth (already) | fuzz |
| P3 | Mass assignment on update (extra body fields saved?) | PUT with privileged fields | verify whitelist | privilege/price tampering | strict pick-list | test extra fields ignored |

## 7. Database Findings

Category: ADD unique(name,type)+slug unique. Service: ADD `{categoryId,isActive}` + `{isActive,zoneRestricted}` indexes; coveragePolygon 2dsphere (verify); freeze snapshot-relevant fields via app guard (price changes create new effective state, never rewrite history — history already snapshotted downstream so no migration). Product: text index exists — verify weights + add `{isActive}` compound for filtered search. CommissionRule: ADD `{serviceId,effectiveFrom desc}` compound + unique (serviceId,version).

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| services by category/active | NEW {categoryId,isActive,updatedAt desc} | paginate |
| location-aware listing | availability resolver per service (N resolver calls?) | check N+1: resolver per row → batch by zone (single mapping query $in serviceIds) |
| product search | text + paginate ✓ | verify explain (TEXT + filter) + cap limit |
| rule latest per service | NEW {serviceId,effectiveFrom:-1} | single read, no scan |

N+1 risk: `getAllServices` resolving availability per service individually → rewrite as two batched queries (services page → mappings $in → merge). Verify with explain + countQueries in test.

## 9. Concurrency Findings

- Double category create same name+type: both pass guard → dup. Fix: unique index + catch 409. No Redis.
- Concurrent price update + booking snapshot: snapshot reads committed rule version; last-wins on rule is fine (each booking pins what it read). Acceptable; document.
- Concurrent image replace: last-wins; delete-old-after-success keyed by public_id of replaced version only. OK.

## 10. Transaction Findings

- Service/product create + image upload: Cloudinary outside txn (external) → create doc first, upload second, save urls (current). KEEP (no txn with external). Failure → imageless doc + retry upload. Document.
- Category create: single-doc → NO txn. Commission rule version bump: single insert (append-only, never update) → NO txn. Per-booking override (M6/M8): booking update + audit → txn (covered in M6/M8).

## 11. Outbox / Worker Findings

None needed. Catalog changes do NOT synchronously fan out; downstream (M6 rebroadcast/M4 listing) reads live on next request + M6 cron covers in-flight. Optional future: `catalog.changed` event for cache invalidation — only if a cache is introduced (none today). Do NOT add outbox prematurely.

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| create category/service/product | none currently | retry may dup → ADD client-supplied `clientRequestId` optional? (recommend: admin UI confirm + list-check; server: dup-guard via unique where natural) |
| update | last-wins | replay safe |
| image add/remove | public_id-keyed | replay safe |
| rule create | append-only version | replay creates new version (avoid: dedupe same % within 1m → return existing) |

## 13. API Contract Findings

Paths are legacy-flavored (`/getAllServices`, `/updateService/:id`) — keep (mobile compat), add canonical REST aliases? NO — avoid churn for M4; document as-is. Add pagination params (backward-compat defaults). Codes: 409 dup, 404 unknown id, 400 validation, 422 product-delete-blocked (semantically invalid due to active bookings — use 409 CONFLICT instead? Decide: 409 with code ACTIVE_BOOKINGS_EXIST). Image routes: multipart; document field names + limits.

## 14. Target Architecture

```text
Route (Auth? public reads, Admin/Owner writes) → Validator → Controller-thin → Service (catalog.service, pricing.service)
 → Repository → Mongo. Images: Controller → storage adapter (Cloudinary) → save urls (no txn).
```

## 15. Target Schema

KEEP all four; ADD indexes/uniques above; ADD `images[{publicId,url}]` structured (MIGRATE from string arrays if applicable — verify current shape first); ADD `deletedAt` soft-delete for Service/Product (history preserved; bookings already snapshot) vs hard-delete — recommend soft-delete + `isActive=false` (MIGRATE: map delete → deactivate where bookings exist, already guarded).

## 16. Target Query Design

Paged, filtered, batched-availability reads; all IXSCAN-verified; text search capped; rule-latest single indexed read.

## 17. Target File Structure

```text
modules/catalog/
├── routes/catalog.routes.js   # same paths (compat), paginated
├── controllers/category|service|product|commission.controller.js (thin)
├── services/catalog.service.js | pricing.service.js (snapshot — frozen contract)
├── repositories/*.repo.js
├── validators/catalog.validator.js  # NEW
└── tests/...
```

## 18. State Machine

`isActive: true ⇄ false`; Category/Service/Product lifecycle is soft (no order machine). CommissionRule: append-only `v1 → v2 → …` (never update/delete; latest effective). Guarded by services.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Dup category | 409 | racy 500? | unique + 409 |
| Delete product w/ active bookings | 409 block | blocked | KEEP + code |
| Price change mid-checkout | new bookings use new, old snapshots frozen | snapshot pattern | KEEP + test |
| Image upload fail | doc without images + retry | partial | documented retry |
| Unknown category on create | 400/404 | 400? | 404 CATEGORY_NOT_FOUND |
| Huge catalog list | page | unbounded | paginate |

## 20. Test Plan

Unit (snapshot pinning, rule latest-wins, slug); integration (create+images, delete-block); API (pagination, role matrix, tech-pricing-hidden); concurrency (double category → one 409); security (mass-assignment, upload fuzz); failure (Cloudinary down); regression (listing shape pinned); load (listing p95).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (snapshot contract + listing shape). P3 additive indexes/uniques background. P4 thin controllers + validators + batched availability + pagination compat. P5 soft-delete mapping. P6 image shape migration (if needed, dual-read). P7 shadow (compare old/new listing outputs). P8 switch. P9 monitor. P10 cleanup. Rollback: redeploy; additive-only until P6 (backup first).

## 22. Production Verification Checklist

Code (single snapshot writer, whitelisted updates); DB (uniques/indexes/explain/pagination); Security (role matrix, pricing-hidden, upload policy); Reliability (idempotent-safe admin ops, no txn needed except override path); Observability (requestId, slow-query log, image-fail metric); Tests green; Deployment (background indexes, compat, rollback).

## 23-26. Files

- Create: validators, repos, tests, (optional) storage adapter interface.
- Modify: schemas (indexes/uniques/images shape), controllers (paginate + whitelist + batched availability), routes (pagination params docs).
- Merge: none (no dups).
- Delete: none (no dead code identified; verify unused image helpers before any removal).

## 27. Risks / Open Questions

Image shape (string[] vs object[]) — verify before migrating. Soft-delete vs hard-delete product policy — recommend soft. Snapshot contract shared with M6/M7/M8 — FROZEN, changes need joint review. Cross-module: M3 (availability/mapping filter), M5 (cart refs itemId), M6 (service snapshot + coverage), M7 (product snapshot + delete-block), M8 (payment snapshot copy).

## 28. Final Acceptance Criteria

Listing paginated + location-filtered + tech-pricing-hidden verified; snapshot contract tests green; no dup categories; delete-block enforced; image lifecycle clean; indexes verified; tests green.

### Can this module safely be rewritten now?

```text
YES
```

Lowest-risk module; only condition: freeze the snapshot contract (joint sign-off M6/M7/M8) and keep response shapes. Must NOT break: M3 availability filter, M5 cart item refs, M6/M7 snapshot readers, M8 payment copy.
