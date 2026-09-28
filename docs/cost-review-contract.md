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

These methods require a server advertising `costReviewV1`; typed HTTP inputs
require `jobInputs`. Native processes and snapshot admission reject these
HTTP-only options. Cancellation stops waiting, not necessarily server effects.
A transport failure may leave a review or job admitted: observe the known id,
or explicitly replay the same idempotency key and exact request. The SDK
never infers that a lost response means no effect.
