# Explicit HTTP cost review

The SDK contract includes the optional `costReviewV1` extension from engine
`cf9d5d5360344322056e8472357f115a067bcf56`. Its committed RFC 7386 patch
`crates/nika-serve/src/server/cost_review/openapi.json` has SHA-256
`7cc47b6398d20ea1ae8f231683ccadc48e04b648bc490730ffd889d394ca0f2b`.
The patch composed with that engine’s base OpenAPI exactly equals its served
contract (SHA-256 `6c331113bc1e89b13e71c94579fe66c4907720963debd536642499ad3957eca1`).
The existing native authoring V2 contract remains pinned separately; this
document is a union of capability-gated contracts, not evidence that the C6
binary supports native authoring V2. Qualification of a composed engine is separate.

`prepareCostReview(request, options)` prepares a review of a served workflow.
It can take the project cost lease and create or reconcile the cost journal;
it creates no job. A result with `review_required: false` has no review to approve.
`costReview(id)` observes a review. `decideCostReview(id, decision)` sends only
the caller’s explicit `approve_once` or `decline` decision and witness. No SDK
method automatically approves, renews, retries, or submits a job.

To run an approved review, call `run(workflow, { inputs, access, costReview:
{ review_id, witness_sha256 }, idempotencyKey })`. Workflow, inputs and access
must match the reviewed request. Inputs use the HTTP engine’s typed JSON
`inputs` field; native `vars` remains a separate option. A review expires after
300 seconds, including after approval. Restart, eviction, changed inputs or
world observations cannot silently re-grant authority. Refusals retain the
engine code and HTTP status in `NikaOperationError`.

Without an explicit version these methods require `costReviewV1`; typed HTTP inputs
require `jobInputs`. Native processes and snapshot admission reject these
HTTP-only options. Cancellation stops waiting, not necessarily server effects.
A transport failure may leave a review or job admitted: observe the known id,
or explicitly replay the same idempotency key and exact request. The SDK
never infers that a lost response means no effect.

## Explicit dispatch-bound V2

Pass `{ version: 2 }` to `prepareCostReview`, `costReview`, and
`decideCostReview` to use `/v2/cost-reviews`. The resident must advertise
`costReviewV2`; an absent capability, a refusal, or a lost response never
causes a retry or a fallback to V1. Read and decide at the version that created
the review. The job reference remains `{ review_id, witness_sha256 }` on the
existing job door. A V1 review request remains V1 even on a V2-capable server.

The V2 types are `NikaCostReviewV2` and `NikaCostReviewResultV2`. Their
`dispatch` reports the engine's total requests, maximum in flight, authored
retry flag and per-task bound. `bounds.transport_retries` is zero. The SDK
validates their wire shape and agreement between the repeated total and width;
it does not recalculate the engine's bound or turn observations into billing
proof. A `review_required: false` result has no review reference or approval.

```ts
const result = await nika.prepareCostReview(
  { workflow: 'survey', inputs: { items: ['a', 'b', 'c'] } },
  { version: 2, idempotencyKey: 'survey-review-1' },
);
if ('review_id' in result) {
  console.log(result.question, result.dispatch);
  // The application obtains the caller's explicit decision separately.
}
```

The V2 OpenAPI addition is the engine-owned RFC 7386 patch
`crates/nika-serve/src/server/cost_review/openapi-v2.json` at engine
`6196415d99d91cae7e2b0654204775f134ecb1b5`, SHA-256
`4b2febc74fe147555af320651ba5557eba8621e19266d56e4d7515686d74035f`.
It adds three routes and four schemas while preserving the pinned V1 routes
and schemas. This contract pin alone is not qualification of a release artifact.
