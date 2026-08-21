import { describe, expect, it } from "vitest";

import { readJson, readMultipart } from "../src/http";

const APP_ORIGIN = "https://servethecays.test";

describe("bounded request parsing", () => {
  it("cancels a streaming JSON body as soon as it exceeds the limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40).fill(0x20));
        if (pulls >= 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    await expect(readJson(request, 64)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(4);
  });

  it("parses a bounded form after streaming it through the byte limit", async () => {
    const request = new Request(`${APP_ORIGIN}/api/test`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Abaco helpers", category: "community" }),
    });

    const parsed = await readMultipart(request, 256);
    expect(parsed.fields).toMatchObject({ name: "Abaco helpers", category: "community" });
  });
});
