import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSmsBd } from "../src/sms/bulksmsbd";
import { MimSms } from "../src/sms/mimsms";
import { dispatch } from "../src/sms/dispatch";
import { postProviderJson } from "../src/sms/http";
import { renderTemplate } from "../src/sms/template";
import type { ISmsProvider } from "../src/shared/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mim = () => new MimSms({ apiKey: "test-key", username: "test-user", senderName: "test-sender" });
const bulk = () => new BulkSmsBd({ apiKey: "test-key", senderId: "test-sender" });

describe("provider failover", () => {
  it("bounds provider failure reasons before replicating them into the API result", async () => {
    const provider: ISmsProvider = { name: "bulksmsbd", send: vi.fn(async () => [{ accepted: false, reason: "large".repeat(20_000) }]), sendDynamic: vi.fn() };
    const results = await dispatch([{ provider }], { kind: "uniform", message: "hi", recipients: ["01712345678"] });
    expect(results[0]?.reason?.length).toBe(500);
  });
  it("retries only declined recipients and restores original order", async () => {
    const primary: ISmsProvider = { name: "bulksmsbd", send: vi.fn(async () => [{ accepted: true, trackingId: "one" }, { accepted: false, reason: "declined" }]), sendDynamic: vi.fn() };
    const fallback: ISmsProvider = { name: "mimsms", send: vi.fn(async () => [{ accepted: true, trackingId: "two" }]), sendDynamic: vi.fn() };
    const input = { kind: "uniform" as const, message: "hello", recipients: ["01712345678", "01712345679"] };
    const results = await dispatch([{ provider: primary }, { provider: fallback }], input);
    expect(fallback.send).toHaveBeenCalledWith(["01712345679"], "hello");
    expect(results).toMatchObject([{ to: "01712345678", trackingId: "one", provider: "bulksmsbd" }, { to: "01712345679", trackingId: "two", provider: "mimsms" }]);
  });
  it("keeps failure reasons scoped to their recipient", async () => {
    const provider: ISmsProvider = { name: "bulksmsbd", send: vi.fn(async () => [{ accepted: false, reason: "first" }, { accepted: false, reason: "second" }]), sendDynamic: vi.fn() };
    const results = await dispatch([{ provider }], { kind: "uniform", message: "hi", recipients: ["01712345678", "01712345679"] });
    expect(results[0]?.reason).toContain("first");
    expect(results[0]?.reason).not.toContain("second");
  });
});

describe("MiMSMS response attribution", () => {
  it("matches full international numbers and keeps accepted duplicate occurrences", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ statusCode: 200, status: "success", success_Data: [{ mobNumber: "8801712345678", trackingId: "accepted" }], error_Data: [{ mobNumber: "8801712345678", reason: "duplicate rejected" }] })));
    const outcomes = await mim().sendDynamic([{ to: "01712345678", message: "first" }, { to: "01712345678", message: "second" }]);
    expect(outcomes).toEqual([{ accepted: true, trackingId: "accepted" }, { accepted: false, reason: "duplicate rejected", failure: "recipient" }]);
  });
  it("does not attribute success across countries with the same last ten digits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ statusCode: 200, status: "success", success_Data: [{ mobNumber: "441712345678", trackingId: "UK" }], error_Data: [null] })));
    const outcomes = await mim().send(["441712345678", "8801712345678"], "hi");
    expect(outcomes[0]).toMatchObject({ accepted: true, trackingId: "UK" });
    expect(outcomes[1]?.accepted).toBe(false);
  });
  it("unreadable entries cannot crash a batch that has known successes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ statusCode: "200", status: "success", success_Data: [null, { mobNumber: 123 }, { mobNumber: "8801712345678", trackingId: "ok" }], error_Data: [null, { to: 42, message: { bad: true } }] })));
    expect(await mim().send(["01712345678"], "hi")).toEqual([{ accepted: true, trackingId: "ok" }]);
  });
});

describe("provider transport", () => {
  it("uses form encoding for BulkSMSBD dynamic bodies and refuses redirects", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ response_code: 202, message_id: "one" }));
    vi.stubGlobal("fetch", fetch);
    expect(await bulk().sendDynamic([{ to: "01712345678", message: "Hello & goodbye" }])).toEqual([{ accepted: true, trackingId: "one" }]);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    // Workers rejects redirect: "error"; "manual" + refusing 3xx is the equivalent.
    expect(init.redirect).toBe("manual");
    const body = init.body as URLSearchParams;
    expect(JSON.parse(body.get("messages")!)).toEqual([{ to: "01712345678", message: "Hello & goodbye" }]);
  });
  it("treats a redirect as a provider refusal instead of following it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } })));
    expect(await bulk().send(["01712345678"], "hi")).toEqual([
      { accepted: false, reason: "BulkSmsBd answered with a redirect (302)", failure: "provider" },
    ]);
  });
  it("rejects oversized streaming responses even without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); } }))));
    await expect(postProviderJson("test", "https://provider.test", "{}", {}, 1000)).rejects.toThrow("too large");
  });
  it("keeps the timeout active after headers arrive", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); },
    }))));
    await expect(postProviderJson("test", "https://provider.test", "{}", {}, 10)).rejects.toThrow("timed out");
  });
  it.each([null, [], "bad"]) ("declines non-object JSON responses (%j)", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    expect((await bulk().send(["01712345678"], "Hi"))[0]?.accepted).toBe(false);
  });
});

it("template tokens never read inherited properties", () => {
  expect(renderTemplate("%NAME% %MISSING% %__PROTO__%", { NAME: "Rahim" })).toBe("Rahim  ");
  const vars = Object.create({ NAME: "inherited" }) as Record<string, string>;
  expect(renderTemplate("%NAME%", vars)).toBe("");
});
