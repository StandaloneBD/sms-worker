/**
 * R2 layout of a Job (ADR 0005). Everything lives under `jobs/{jobId}/`:
 *
 *  - `payload.ndjson` — one self-contained ChunkPayload per line. Each chunk
 *    row in D1 records its line's byte range, so a consumer reads only its
 *    own chunk with a ranged GET instead of downloading and parsing the
 *    whole Job (which made every chunk cost O(job size) in R2 reads and CPU).
 *  - `results/{chunkIndex}-{round}.json` — a round's dispatch results,
 *    written right after the send and deleted once the round is settled in
 *    D1, so a redelivery between the two never sends the round again.
 *
 * Jobs created before this layout have a single `jobs/{jobId}.json` document
 * (LegacyJobPayload); their chunk rows carry no byte range and are read here
 * by slicing that document.
 */

import {
  r2ChunkResultsKey,
  r2JobPayloadKey,
  r2JobPrefix,
  r2LegacyJobKey,
} from "../shared/constants";
import type {
  ChunkPayload,
  DispatchResultItem,
  JobPayloadHeader,
  JobRecipient,
  LegacyJobPayload,
} from "../shared/types";

/** One chunk as laid out in the payload: recipient count and byte range. */
export interface EncodedChunk {
  total: number;
  offset: number;
  length: number;
}

/**
 * Encodes a Job's recipients as NDJSON chunk lines of `chunkSize`, each
 * carrying the job-level header (a few KB at most, so repeating it per line
 * is cheap next to letting every chunk stand alone).
 */
export function encodeJobPayload(
  header: JobPayloadHeader,
  recipients: readonly JobRecipient[],
  chunkSize: number,
): { body: Uint8Array; chunks: EncodedChunk[] } {
  const encoder = new TextEncoder();
  const lines: Uint8Array[] = [];
  const chunks: EncodedChunk[] = [];
  let offset = 0;
  for (let start = 0, chunkIndex = 0; start < recipients.length; start += chunkSize, chunkIndex++) {
    const slice = recipients.slice(start, start + chunkSize);
    const line: ChunkPayload = { ...header, chunkIndex, recipients: slice };
    const bytes = encoder.encode(`${JSON.stringify(line)}\n`);
    lines.push(bytes);
    chunks.push({ total: slice.length, offset, length: bytes.byteLength });
    offset += bytes.byteLength;
  }

  const body = new Uint8Array(offset);
  let position = 0;
  for (const line of lines) {
    body.set(line, position);
    position += line.byteLength;
  }
  return { body, chunks };
}

export async function writeJobPayload(env: Env, jobId: string, body: Uint8Array): Promise<void> {
  await env.PAYLOADS.put(r2JobPayloadKey(jobId), body);
}

/** Where a chunk's line is, as recorded on its D1 row. */
export interface ChunkLocation {
  chunkIndex: number;
  payloadOffset: number | null;
  payloadLength: number | null;
}

/** Reads one chunk's payload; null when the object is gone. R2 errors throw. */
export async function readChunkPayload(env: Env, jobId: string, chunk: ChunkLocation): Promise<ChunkPayload | null> {
  if (chunk.payloadOffset !== null && chunk.payloadLength !== null) {
    const object = await env.PAYLOADS.get(r2JobPayloadKey(jobId), {
      range: { offset: chunk.payloadOffset, length: chunk.payloadLength },
    });
    if (!object) return null;
    return JSON.parse(await object.text()) as ChunkPayload;
  }

  const object = await env.PAYLOADS.get(r2LegacyJobKey(jobId));
  if (!object) return null;
  const { chunkSize, recipients, ...header } = await object.json<LegacyJobPayload>();
  const start = chunk.chunkIndex * chunkSize;
  return { ...header, chunkIndex: chunk.chunkIndex, recipients: recipients.slice(start, start + chunkSize) };
}

export async function readRoundResults(
  env: Env,
  jobId: string,
  chunkIndex: number,
  round: number,
): Promise<DispatchResultItem[] | null> {
  const object = await env.PAYLOADS.get(r2ChunkResultsKey(jobId, chunkIndex, round));
  return object ? object.json<DispatchResultItem[]>() : null;
}

export async function writeRoundResults(
  env: Env,
  jobId: string,
  chunkIndex: number,
  round: number,
  results: readonly DispatchResultItem[],
): Promise<void> {
  await env.PAYLOADS.put(r2ChunkResultsKey(jobId, chunkIndex, round), JSON.stringify(results));
}

export async function deleteRoundResults(env: Env, jobId: string, chunkIndex: number, round: number): Promise<void> {
  await env.PAYLOADS.delete(r2ChunkResultsKey(jobId, chunkIndex, round));
}

/** Deletes every object a Job wrote, legacy payload included. */
export async function deleteJobObjects(env: Env, jobId: string): Promise<void> {
  const keys = [r2LegacyJobKey(jobId)];
  let cursor: string | undefined;
  do {
    const list = await env.PAYLOADS.list({ prefix: r2JobPrefix(jobId), cursor });
    keys.push(...list.objects.map((object) => object.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  // R2 deletes at most 1000 keys per call.
  for (let start = 0; start < keys.length; start += 1000) {
    await env.PAYLOADS.delete(keys.slice(start, start + 1000));
  }
}
