import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./types";

/** Count the bytes actually consumed, even with a missing or inaccurate header.
 * Streams straight into the parser instead of retaining a second body copy. */
export function requestBodyLimit(maxBytes: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const raw = c.req.raw;
    if (Number(raw.headers.get("content-length")) > maxBytes) {
      throw new HTTPException(413, { message: "request body too large" });
    }
    if (raw.body) {
      let bytes = 0;
      const body = raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            throw new HTTPException(413, { message: "request body too large" });
          }
          controller.enqueue(chunk);
        },
      }));
      c.req.raw = new Request(raw, { body });
    }
    await next();
  });
}
