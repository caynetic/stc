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
  const stripTag = (
    source: string,
    tag: "script" | "link",
    shouldRemove: (openingTag: string) => boolean,
  ): string => {
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
        output += source.slice(cursor, start + prefix.length);
        cursor = start + prefix.length;
        continue;
      }
      const openEnd = source.indexOf(">", start);
      if (openEnd < 0) {
        output += source.slice(cursor);
        break;
      }
      if (tag === "script") {
        const closeStart = lower.indexOf("</script", openEnd + 1);
        const closeEnd = closeStart < 0 ? -1 : source.indexOf(">", closeStart);
        if (closeEnd < 0) {
          output += source.slice(cursor);
          break;
        }
        if (!shouldRemove(source.slice(start, openEnd + 1))) {
          output += source.slice(cursor, closeEnd + 1);
        } else {
          output += source.slice(cursor, start);
        }
        cursor = closeEnd + 1;
      } else if (shouldRemove(source.slice(start, openEnd + 1))) {
        output += source.slice(cursor, start);
        cursor = openEnd + 1;
      } else {
        output += source.slice(cursor, openEnd + 1);
        cursor = openEnd + 1;
      }
    }
    return output;
  };

  const withoutScripts = stripTag(html, "script", () => true);
  const withoutOfflineLinks = stripTag(withoutScripts, "link", (openingTag) => {
    if (/\brel\s*=\s*["'][^"']*\b(?:canonical|icon|apple-touch-icon|manifest)\b/i.test(openingTag)) return true;
    return /\brel\s*=\s*["'][^"']*\bstylesheet\b/i.test(openingTag)
      && /\bhref\s*=\s*["'](?:https?:)?\/\//i.test(openingTag);
  });

  const withoutRemoteAssets = withoutOfflineLinks.replace(
    /\s(?:src|srcset)\s*=\s*["'](?:https?:)?\/\/[^"']*["']/gi,
    "",
  );

  return withoutRemoteAssets
    .replaceAll('href="/static/', 'href="../static/')
    .replaceAll('href="/assets/', 'href="../assets/')
    .replaceAll('src="/static/', 'src="../static/')
    .replaceAll('src="/assets/', 'src="../assets/')
    .replaceAll('srcset="/static/', 'srcset="../static/')
    .replaceAll('srcset="/assets/', 'srcset="../assets/')
    .replace(/content="https:\/\/servethecays\.test\/static\/images\/logo\.png"/g, 'content="../assets/logo.png"')
    .replace(/content="https:\/\/servethecays\.test[^\"]*"/g, 'content="../index.html#offline-action-note"')
    .replace(/href="\/(?!assets\/|static\/)[^"]*"/g, 'href="../index.html#offline-action-note"')
    .replace(/href="(?:mailto:|(?:https?:)?\/\/)[^"]*"/g, 'href="../index.html#offline-action-note"')
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
    expect(files[path]).not.toMatch(/\b(?:src|srcset)\s*=\s*["'](?:https?:)?\/\//i);
    expect(files[path]).not.toMatch(/\b(?:src|srcset)\s*=\s*["']\/(?:static|assets)\//i);
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
  expect(files["states/admin.html"]).toContain('href="../static/css/style.css"');
  expect(files["states/admin.html"]).toContain('href="../assets/styles.css"');

  const literalMarkup = offlineHtml('<!doctype html><head><link rel="canonical" href="https://servethecays.com/example"><link rel="stylesheet" href="https://cdn.example.invalid/style.css"><link href="//cdn.example.invalid/protocol-relative.css" rel="stylesheet"><link href="/static/css/style.css" rel="stylesheet"><link rel="stylesheet" href="/static/css/legacy.css"><link rel="stylesheet" href="/assets/styles.css"><scripture>keep this text</scripture><linkage>keep this text too</linkage><img src="https://img.example.invalid/reviewer.gif" srcset="//img.example.invalid/reviewer-2x.gif 2x" alt="remote"><source srcset="/assets/logo.svg 1x"></head><body></body>');
  expect(literalMarkup).toContain('<link rel="stylesheet" href="../static/css/legacy.css">');
  expect(literalMarkup).toContain('<link href="../static/css/style.css" rel="stylesheet">');
  expect(literalMarkup).toContain('<link rel="stylesheet" href="../assets/styles.css">');
  expect(literalMarkup).not.toContain("cdn.example.invalid");
  expect(literalMarkup).not.toContain("img.example.invalid");
  expect(literalMarkup).toContain('<source srcset="../assets/logo.svg 1x">');
  expect(literalMarkup).not.toContain('rel="canonical"');
  expect(literalMarkup).toContain("<scripture>keep this text</scripture>");
  expect(literalMarkup).toContain("<linkage>keep this text too</linkage>");
});
