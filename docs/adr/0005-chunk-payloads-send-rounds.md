# 0005: Chunk-addressable payloads, send rounds, and round checkpoints

Status: accepted (2026-10-20)

## Context

A bulk Job was one JSON document in R2 (`jobs/{jobId}.json`, ADR 0001), and
every chunk's queue invocation downloaded and parsed all of it to slice out
250 recipients. Measured: 6–20 ms of CPU per chunk for `JSON.parse` alone;
a 50k-recipient Job (200 chunks) read 0.7–1.9 GB from R2 in total. On
Workers Free one chunk's parse already exceeds the 10 ms CPU limit.

Retries only covered infrastructure errors. Provider adapters turned
timeouts and 5xx into plain `accepted: false`, the consumer marked the chunk
done, and a provider outage became a permanent failure for every recipient
in flight. Meanwhile a failure *between* dispatch and the D1 claim re-sent
the whole chunk on each of up to 6 deliveries before the DLQ marked it
failed anyway. Chunks whose DLQ message dropped stayed `pending` forever,
their Job stuck in `running` and never purged.

## Decision

**Payload layout.** A Job's R2 objects live under `jobs/{jobId}/`.
`payload.ndjson` holds one self-contained `ChunkPayload` per line (job-level
header + that chunk's recipients). Each `job_chunks` row records its line's
byte range (`payload_offset`, `payload_length`), and the consumer reads it
with a ranged GET. Legacy Jobs (no byte range on their rows) are still read
from `jobs/{jobId}.json`.

**Failure kinds.** Every declined outcome carries a `FailureKind`:
`transport` (no definitive answer), `provider` (refused for a reason on the
provider's side), `recipient` (this recipient rejected). `dispatch()` marks
an unresolved recipient `retryable` when any provider failed it for a
transport or provider-side reason.

**Send rounds.** A chunk is processed in rounds (`job_chunks.round`, up to
`SEND_ROUNDS`). Each queue message names its round and only acts while the
chunk is `pending` in that round. When a round settles, accepted and
permanently failed recipients are recorded; retryable ones are stored in
`retry_indexes` and the chunk advances to the next round, which is enqueued
with backoff (60 s, 120 s, 240 s). The last round records everything.

**Round checkpoints.** Right after a round's dispatch, its results are
written to `jobs/{jobId}/results/{chunkIndex}-{round}.json`. A redelivery of
the same round replays them instead of sending again; the checkpoint is
deleted once the round is settled in D1.

**Settling.** `settleChunkRound` claims the round and rolls up the Job's
counters in one D1 batch. The Job update is guarded by a fresh claim token
written by the claim statement, so it applies exactly when the claim did,
and it increments counters rather than recomputing aggregates over every
chunk.

**Force-finish and reaper.** The DLQ consumer and a cron reaper (every 15
minutes) share `forceFinishChunk`: a dispatched-but-unsettled round is
recorded from its checkpoint, everything else still pending is failed. The
reaper re-enqueues pending chunks idle for `CHUNK_STALE_SECONDS` and
force-finishes them after `CHUNK_MAX_REQUEUES`. A failed enqueue (at Job
submission, or of a retry round) marks the chunk idle so the next reaper run
picks it up, instead of failing the request.

## Consequences

- Per-chunk R2 reads and CPU are proportional to the chunk, not the Job.
- A provider outage shorter than the round backoff no longer fails a Job.
- Duplicate sends are confined to a crash during dispatch itself (no
  checkpoint written yet). At-least-once (ADR 0002) still holds.
- Every Job reaches a terminal status, so retention can purge it.
- Cost: one R2 put (and a free delete) per chunk round, a slightly larger
  payload (the header repeats on each line, a few KB at most), and a few
  more `job_chunks` columns.
- Sync sends have no rounds: the caller gets `retryable` per recipient and
  decides.
