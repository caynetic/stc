import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import {
  adminPage,
  memberDashboardPage,
  newsletterConfirmationPage,
  serverErrorPage,
  signInVerifyPage,
  signOutPage,
  unsubscribePage,
} from "../src/pages";
import type { Env } from "../src/types";

const baseEnv = env as unknown as Env;

function offlineHtml(html: string): string {
  const stripTag = (source: string, tag: "script" | "link"): string => {
    const lower = source.toLowerCase();
    const prefix = `<${tag}`;
    let cursor = 0;
    let output = "";
    while (cursor < source.length) {
      const start = lower.indexOf(prefix, cursor);
      if (start < 0) {
        output += source.slice(cursor);
        break;
      }
      const boundary = source[start + prefix.length] ?? "";
      if (boundary && ![" ", "\t", "\n", "\r", ">", "/"].includes(boundary)) {
        cursor = start + prefix.length;
        continue;
      }
      const openEnd = source.indexOf(">", start);
      if (openEnd < 0) {
        output += source.slice(cursor);
        break;
      }
      output += source.slice(cursor, start);
      if (tag === "script") {
        const closeStart = lower.indexOf("</script", openEnd + 1);
        const closeEnd = closeStart < 0 ? -1 : source.indexOf(">", closeStart);
        if (closeEnd < 0) {
          output += source.slice(start, openEnd + 1);
          cursor = openEnd + 1;
          continue;
        }
        cursor = closeEnd + 1;
      } else {
        cursor = openEnd + 1;
      }
    }
    return output;
  };

  return stripTag(stripTag(html, "script"), "link")
    .replaceAll('href="/static/', 'href="../static/')
    .replaceAll('href="/assets/', 'href="../assets/')
    .replaceAll('src="/static/', 'src="../static/')
    .replaceAll('src="/assets/', 'src="../assets/')
    .replace(/content="https:\/\/servethecays\.test\/static\/images\/logo\.png"/g, 'content="../assets/logo.png"')
    .replace(/content="https:\/\/servethecays\.test[^\"]*"/g, 'content="../index.html#offline-action-note"')
    .replace(/href="\/(?!assets\/|static\/)[^"]*"/g, 'href="../index.html#offline-action-note"')
    .replace(/href="(?:mailto:|https:\/\/)[^"]*"/g, 'href="../index.html#offline-action-note"')
    .replace("</body>", '<p class="review-evidence-banner">Offline review capture rendered directly from the production page builder. Live actions are disabled.</p></body>');
}

it("exports representative protected, auth, confirmation, and error renderers for offline review", async () => {
  const renderers: Record<string, Response> = {
    "states/admin.html": adminPage(baseEnv),
    "states/member-session-checking.html": memberDashboardPage(baseEnv),
    "states/signin-verify.html": signInVerifyPage(baseEnv),
    "states/signout.html": signOutPage(baseEnv),
    "states/newsletter-confirmation.html": newsletterConfirmationPage(baseEnv),
    "states/unsubscribe.html": unsubscribePage(baseEnv, "offline-review-token"),
    "states/server-error.html": serverErrorPage(baseEnv),
  };
  const files: Record<string, string> = {};
  for (const [path, response] of Object.entries(renderers)) {
    files[path] = offlineHtml(await response.text());
    expect(files[path].toLowerCase()).toContain("<!doctype html>");
    expect(files[path]).toContain("Offline review capture rendered directly from the production page builder.");
  }
  expect(Object.keys(files)).toHaveLength(7);
  expect(files["states/admin.html"]).toContain("data-submission-pagination");
  expect(files["states/admin.html"]).toContain("data-published-event-pagination");
  expect(files["states/member-session-checking.html"]).toContain("Checking your session");
  expect(files["states/signin-verify.html"]).toContain("Confirm this sign-in");
  expect(files["states/signout.html"]).toContain("Sign out of Serve the Cays");
  expect(files["states/signout.html"]).toContain("data-stc-signout-confirm");
  expect(files["states/signout.html"]).toContain("Cancel and return home");
  expect(files["states/newsletter-confirmation.html"]).toContain("Confirm your subscription");
  expect(files["states/unsubscribe.html"]).toContain("Confirm unsubscribe");
  expect(files["states/server-error.html"]).toContain("A squall rolled through our servers");
});
