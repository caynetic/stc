import { describe, expect, it } from "vitest";

import {
  CloudflareEmailDeliveryError,
  sendTransactionalViaCloudflare,
} from "../src/cloudflare-email";
import type { Env } from "../src/types";

function testEnv(sender?: SendEmail): Env {
  return { EMAIL: sender } as Env;
}

function input() {
  return {
    id: "email_cloudflare_transport_test",
    fromEmail: "signin@servethecays.com",
    replyTo: "hello@servethecays.com",
    to: "member@example.org",
    subject: "Your Serve the Cays sign-in link",
    text: "Use the secure link.",
    html: "<p>Use the secure link.</p>",
  };
}

describe("Cloudflare Email Service transport", () => {
  it("uses the structured binding and returns the Cloudflare message ID", async () => {
    const messages: EmailMessageBuilder[] = [];
    const sender: SendEmail = {
      async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
        if (!("subject" in message)) throw new Error("Expected structured email");
        messages.push(message);
        return { messageId: "cloudflare-message-id" };
      },
    };

    await expect(sendTransactionalViaCloudflare(testEnv(sender), input())).resolves.toEqual({
      provider: "cloudflare_email_service",
      providerMessageId: "cloudflare-message-id",
    });
    expect(messages[0]).toMatchObject({
      to: "member@example.org",
      from: { email: "signin@servethecays.com", name: "Serve the Cays" },
      replyTo: "hello@servethecays.com",
      headers: { "X-Entity-Ref-ID": "email_cloudflare_transport_test" },
    });
  });

  it.each([
    ["E_RATE_LIMIT_EXCEEDED", true, false],
    ["E_DAILY_LIMIT_EXCEEDED", true, false],
    ["E_INTERNAL_SERVER_ERROR", true, false],
    ["E_SENDER_NOT_VERIFIED", false, false],
    ["E_RECIPIENT_SUPPRESSED", false, false],
    ["E_UNKNOWN_RESULT", false, true],
  ])("classifies %s without blind retries", async (code, retryable, uncertain) => {
    const sender: SendEmail = {
      async send(): Promise<EmailSendResult> {
        throw Object.assign(new Error("provider error"), { code });
      },
    };
    const error = await sendTransactionalViaCloudflare(testEnv(sender), input()).catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudflareEmailDeliveryError);
    expect(error).toMatchObject({ code, retryable, uncertain });
  });

  it("fails closed when the binding is absent", async () => {
    await expect(sendTransactionalViaCloudflare(testEnv(), input())).rejects.toMatchObject({
      code: "E_BINDING_MISSING",
      retryable: false,
      uncertain: false,
    });
  });
});
