import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { developmentEmailInbox, processEmailJobs, queueEmail } from "../src/email";
import type { Env } from "../src/types";

const APP_ORIGIN = "https://servethecays.test";
const baseEnv = env as unknown as Env;

function structuredMessage(message: EmailMessage | EmailMessageBuilder): EmailMessageBuilder {
  if (!("subject" in message)) throw new Error("Expected a structured Cloudflare email message");
  return message;
}

function fakeCloudflareEmail(messages: EmailMessageBuilder[]): SendEmail {
  return {
    async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
      messages.push(structuredMessage(message));
      return { messageId: `cloudflare-${messages.length}` };
    },
  };
}

describe("email provider boundary", () => {
  it("uses the restricted Cloudflare binding with distinct sender aliases and the human Reply-To address", async () => {
    const messages: EmailMessageBuilder[] = [];
    const previewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      EMAIL: fakeCloudflareEmail(messages),
      EMAIL_FROM_SIGNIN: undefined,
      EMAIL_FROM_NOTIFICATIONS: undefined,
      EMAIL_REPLY_TO: undefined,
    };

    await queueEmail(previewEnv, {
      kind: "magic_link",
      recipientEmail: "member@example.org",
      idempotencyKey: "provider-boundary-magic-link",
      payload: {
        sign_in_url: `${APP_ORIGIN}/signin/verify#token=development-token`,
        expires_minutes: 15,
      },
    });
    await queueEmail(previewEnv, {
      kind: "welcome",
      recipientEmail: "member@example.org",
      idempotencyKey: "provider-boundary-welcome",
    });
    await processEmailJobs(previewEnv, 25);

    expect(messages).toHaveLength(2);
    expect(messages[0].from).toEqual({ email: "signin@servethecays.com", name: "Serve the Cays" });
    expect(messages[0].replyTo).toBe("hello@servethecays.com");
    expect(messages[0].headers?.["X-Entity-Ref-ID"]).toMatch(/^email_[A-Za-z0-9_-]+$/);
    expect(messages[1].from).toEqual({ email: "notifications@servethecays.com", name: "Serve the Cays" });
    expect(messages[1].replyTo).toBe("hello@servethecays.com");
    expect(messages[1].headers?.["X-Entity-Ref-ID"]).toMatch(/^email_[A-Za-z0-9_-]+$/);
  });

  it("keeps local delivery captured and exposes the configured boundary", async () => {
    const localEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "local",
    };

    await queueEmail(localEnv, {
      kind: "magic_link",
      recipientEmail: "local@example.org",
      idempotencyKey: "provider-boundary-local",
      payload: {
        sign_in_url: `${APP_ORIGIN}/signin/verify#token=local-development-token`,
        expires_minutes: 15,
      },
    });

    const response = await developmentEmailInbox(
      new Request(`${APP_ORIGIN}/api/dev/emails`),
      localEnv,
    );
    const body = await response.json<{ emails: Array<Record<string, unknown>> }>();
    expect(body.emails[0]).toMatchObject({
      provider: "cloudflare_email_service",
      from_email: "signin@servethecays.com",
      reply_to_email: "hello@servethecays.com",
      recipient_email: "local@example.org",
      status: "sent",
    });
    expect(String(body.emails[0].html)).toContain("Your secure sign-in link");
    expect(String(body.emails[0].html)).toContain("Sign in to My STC");
    expect(String(body.emails[0].html)).toContain("Community in action");
    expect(String(body.emails[0].html)).toContain("/static/images/email-logo.5a81761f5371.png");
  });

  it("configures provider metadata without putting credentials in test variables", () => {
    expect(baseEnv.NEWSLETTER_DELIVERY_ENABLED).toBe("true");
    expect(baseEnv.NEWSLETTER_FROM_EMAIL).toBe("news@servethecays.com");
    expect(baseEnv.NEWSLETTER_DAILY_LIMIT).toBe("90");
    expect(baseEnv.EMAIL).toBeUndefined();
    expect(baseEnv.FORWARD_EMAIL_NEWSLETTER_PASSWORD).toBeUndefined();
  });

  it("does not blindly resend an uncertain transactional request", async () => {
    let providerCalls = 0;
    const uncertainEmail: SendEmail = {
      async send(): Promise<EmailSendResult> {
        providerCalls += 1;
        throw Object.assign(new Error("provider returned an unknown result"), { code: "E_UNKNOWN_RESULT" });
      },
    };
    const previewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      EMAIL: uncertainEmail,
    };
    await queueEmail(previewEnv, {
      kind: "welcome",
      recipientEmail: "uncertain@example.org",
      idempotencyKey: "provider-boundary-uncertain",
    });

    expect(await processEmailJobs(previewEnv, 25)).toBe(0);
    expect(await processEmailJobs(previewEnv, 25)).toBe(0);
    expect(providerCalls).toBe(1);
    expect(await baseEnv.DB.prepare(
      "SELECT status, attempts, last_error FROM email_jobs WHERE idempotency_key = ?",
    ).bind("provider-boundary-uncertain").first<Record<string, unknown>>()).toMatchObject({
      status: "failed",
      attempts: 5,
    });
  });

  it("returns the generic sign-in response without persisting its token after an uncertain send", async () => {
    let providerCalls = 0;
    const uncertainEmail: SendEmail = {
      async send(): Promise<EmailSendResult> {
        providerCalls += 1;
        throw Object.assign(new Error("provider returned an unknown result"), { code: "E_UNKNOWN_RESULT" });
      },
    };
    const previewEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      MEMBER_APPLICATION_ENABLED: "true",
      MEMBER_SCHEMA_RELEASE_READY: "true",
      ADMIN_STEP_UP_VERIFIED: "true",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_RECONCILIATION_VERIFIED: "true",
      EMAIL: uncertainEmail,
    };
    await expect(queueEmail(previewEnv, {
      kind: "magic_link",
      recipientEmail: "uncertain-signin@example.org",
      idempotencyKey: "provider-boundary-uncertain-signin",
      payload: {
        sign_in_url: `${APP_ORIGIN}/signin/verify#token=must-not-remain-in-email-jobs`,
        expires_minutes: 15,
      },
    })).resolves.toMatch(/^email_/);

    expect(providerCalls).toBe(1);
    const row = await baseEnv.DB.prepare(
      "SELECT status, attempts, payload_json FROM email_jobs WHERE idempotency_key = ?",
    ).bind("provider-boundary-uncertain-signin").first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "failed", attempts: 5 });
    expect(String(row?.payload_json)).not.toContain("must-not-remain-in-email-jobs");
  });

  it("fails closed before queue access when transactional delivery is disabled", async () => {
    const disabledEnv: Env = {
      ...baseEnv,
      ENVIRONMENT: "preview",
      TRANSACTIONAL_EMAIL_DELIVERY_ENABLED: "false",
      DB: new Proxy(baseEnv.DB, {
        get() {
          throw new Error("disabled email delivery touched D1");
        },
      }),
    };

    await expect(processEmailJobs(disabledEnv)).resolves.toBe(0);
    await expect(queueEmail(disabledEnv, {
      kind: "welcome",
      recipientEmail: "disabled@example.org",
      idempotencyKey: "provider-boundary-disabled",
    })).rejects.toMatchObject({ status: 503, code: "email_unavailable" });
  });
});
