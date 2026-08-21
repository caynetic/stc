import { html, redirect } from "./http";
import { eventData, eventListData, organizationData, organizationListData } from "./directory";
import { optionalMemberSession } from "./member-auth";
import { expectedOrigin } from "./security";
import type { CategoryRow, Env, LocationRow } from "./types";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? String(value[key]) : "";
}

function array(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(value[key]) ? (value[key] as Record<string, unknown>[]) : [];
}

function number(value: Record<string, unknown>, key: string): number {
  const candidate = Number(value[key]);
  return Number.isFinite(candidate) ? candidate : 0;
}

function boolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === true || value[key] === 1;
}

function publicDate(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-BS", { dateStyle: "long", timeZone: "America/Nassau" }).format(date);
}

function newsCard(post: Record<string, unknown>): string {
  return `<article class="news-card">
    <p class="news-card-date"><time datetime="${escapeHtml(text(post, "published_at"))}">${escapeHtml(publicDate(post.published_at))}</time></p>
    <h2><a href="/news/${escapeHtml(text(post, "slug"))}">${escapeHtml(text(post, "title"))}</a></h2>
    <p>${escapeHtml(text(post, "summary"))}</p>
    <a class="news-read-more" href="/news/${escapeHtml(text(post, "slug"))}">Read more <span aria-hidden="true">→</span></a>
  </article>`;
}

function pixelHeartMarkup(): string {
  return `<span class="member-pixel-heart" aria-hidden="true"><svg class="member-pixel-heart-svg" viewBox="0 0 7 6" focusable="false" shape-rendering="crispEdges"><path class="member-pixel-heart-outline" d="M1 0H3V1H4V0H6V1H7V3H6V4H5V5H4V6H3V5H2V4H1V3H0V1H1Z"></path><path class="member-pixel-heart-fill" d="M1 0H3V1H4V0H6V1H7V3H6V4H5V5H4V6H3V5H2V4H1V3H0V1H1Z"></path><path class="member-pixel-heart-crack" d="M3 0H4V2H3V3H4V4H3V6H2V4H3V3H2V2H3Z"></path></svg><span class="member-pixel-heart-bit member-pixel-heart-bit-one"></span><span class="member-pixel-heart-bit member-pixel-heart-bit-two"></span></span>`;
}

function memberFavoriteButton(kind: "organization" | "event", id: unknown, name: string, detail = false): string {
  const noun = kind === "organization" ? "organization" : "event";
  return `<button class="member-favorite${detail ? " member-favorite-detail" : ""}" type="button" aria-label="Save this ${noun}" aria-pressed="false" data-favorite-type="${kind}" data-favorite-id="${escapeHtml(id)}" data-favorite-name="${escapeHtml(name)}">${pixelHeartMarkup()}<span class="member-action-label">Save</span></button>`;
}

function safeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\r\n#]/.test(value)) return "/me";
  let path = value;
  try {
    const parsed = new URL(value, "https://servethecays.com");
    if (parsed.origin !== "https://servethecays.com" || parsed.username || parsed.password) return "/me";
    path = parsed.pathname;
  } catch {
    return "/me";
  }
  const allowed = ["/", "/me", "/admin", "/organizations", "/events", "/news", "/about", "/privacy", "/organization/", "/event/", "/news/", "/suggest/organization", "/suggest/event"];
  return allowed.some((allowedPath) => path === allowedPath || (allowedPath !== "/" && allowedPath.endsWith("/") && path.startsWith(allowedPath))) ? value : "/me";
}

function jsonLd(value: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

function turnstile(env: Env, action: string): string {
  if (!env.TURNSTILE_SITE_KEY) return "";
  return `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="${escapeHtml(action)}" data-theme="light" data-appearance="interaction-only" data-size="flexible"></div>`;
}

interface LayoutOptions {
  title: string;
  description: string;
  path: string;
  body: string;
  env: Env;
  keywords?: string;
  noindex?: boolean;
  admin?: boolean;
  turnstile?: boolean;
  referrerPolicy?: "no-referrer";
  extraHead?: string;
  extraBody?: string;
}

function publicLayout(options: LayoutOptions): Response {
  const origin = expectedOrigin(options.env);
  const canonical = `${origin}${options.path}`;
  const socialImage = `${origin}/static/images/logo.png`;
  const isMemberSurface = options.path.startsWith("/signin") || options.path === "/signout" || options.path === "/me" || options.path.startsWith("/suggest/");
  const isUtilitySurface = options.path === "/dev/inbox"
    || options.path.startsWith("/unsubscribe/")
    || options.path === "/newsletter/confirm";
  const surfaceClass = isMemberSurface
    ? "stc-app-surface stc-member-surface"
    : isUtilitySurface
      ? "stc-app-surface stc-utility-surface"
      : "";
  const activeSection = options.path === "/" ? "home"
    : options.path.startsWith("/suggest/") ? "member"
      : options.path.startsWith("/organization") ? "organizations"
      : options.path.startsWith("/event") || options.path === "/suggest/event" ? "events"
        : options.path.startsWith("/news") ? "news"
        : options.path.startsWith("/about") ? "about"
          : options.path.startsWith("/signin") || options.path === "/signout" || options.path === "/me" ? "member"
            : "";
  const memberNavigationLoading = '<span data-member-nav-label></span><span class="sr-only" data-member-nav-status>Checking sign-in status</span>';
  const navLink = (href: string, label: string, section: string, className = "") => `<a href="${href}"${className ? ` class="${className}"` : ""} data-nav-section="${section}"${activeSection === section ? ' aria-current="page"' : ""}>${label}</a>`;
  const turnstileScript = options.turnstile && options.env.TURNSTILE_SITE_KEY
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : "";
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(options.title)}</title>
    <meta name="description" content="${escapeHtml(options.description)}">
    <meta name="keywords" content="${escapeHtml(options.keywords ?? "volunteer, mentorship, youth programs, community service, bahamas, guidance, non-profit")}">
    <meta name="author" content="Serve the Cays">
    <meta name="robots" content="${options.noindex ? "noindex, nofollow" : "index, follow"}">
    <link rel="canonical" href="${escapeHtml(canonical)}">

    <meta property="og:type" content="website">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:title" content="${escapeHtml(options.title)}">
    <meta property="og:description" content="${escapeHtml(options.description)}">
    <meta property="og:image" content="${escapeHtml(socialImage)}">
    <meta property="og:site_name" content="Serve the Cays">
    <meta property="og:locale" content="en_US">

    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${escapeHtml(canonical)}">
    <meta property="twitter:title" content="${escapeHtml(options.title)}">
    <meta property="twitter:description" content="${escapeHtml(options.description)}">
    <meta property="twitter:image" content="${escapeHtml(socialImage)}">

    <link rel="icon" type="image/x-icon" href="/static/images/favicon.ico">
    <link rel="apple-touch-icon" sizes="180x180" href="/static/images/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="32x32" href="/static/images/favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="/static/images/favicon-16x16.png">
    <link rel="manifest" href="/static/images/site.webmanifest">

    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">

    <link rel="stylesheet" href="/static/css/style.css">
    <link rel="stylesheet" href="/static/css/flash.css">
    <link rel="stylesheet" href="/assets/legacy-cloudflare.css">
    <link rel="stylesheet" href="/assets/tailwind.css">
    ${options.extraHead ?? ""}
    ${turnstileScript}
</head>
<body${surfaceClass ? ` class="${surfaceClass}"` : ""} data-environment="${escapeHtml(options.env.ENVIRONMENT ?? "unknown")}">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <header class="stc-simple-header">
        <nav class="stc-simple-nav" aria-label="Primary navigation">
            <div class="nav-links">
                ${navLink("/", "Home", "home")}
                ${navLink("/organizations", "Organizations", "organizations")}
                ${navLink("/events", "Events", "events")}
                ${navLink("/news", "News", "news")}
                ${navLink("/about", "About", "about")}
                <a href="/signin" class="login-btn" data-nav-section="member"${activeSection === "member" ? ' aria-current="page"' : ""} data-member-nav data-member-context="${activeSection === "member" ? "member" : "public"}" data-member-state="checking" aria-busy="true" aria-label="Checking sign-in status" hidden>${memberNavigationLoading}</a>
            </div>
        </nav>
        <button class="hamburger" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="mobile-navigation">
            <span></span>
            <span></span>
            <span></span>
        </button>
        <nav class="mobile-menu" id="mobile-navigation" aria-label="Mobile navigation">
            ${navLink("/", "Home", "home")}
            ${navLink("/organizations", "Organizations", "organizations")}
            ${navLink("/events", "Events", "events")}
            ${navLink("/news", "News", "news")}
            ${navLink("/about", "About", "about")}
            <a href="/signin" data-nav-section="member"${activeSection === "member" ? ' aria-current="page"' : ""} data-member-nav data-member-context="${activeSection === "member" ? "member" : "public"}" data-member-state="checking" aria-busy="true" aria-label="Checking sign-in status" hidden>${memberNavigationLoading}</a>
        </nav>
    </header>

    <main id="main-content" role="main">
        ${options.body}
    </main>
    <p class="member-global-status" role="status" aria-live="polite" data-member-global-status hidden></p>

    <footer class="footer" role="contentinfo">
        <div class="footer-content">
            <div class="footer-section">
                <h3>Serve the Cays</h3>
                <p>Connecting the community with volunteer opportunities, mentorship programs, and guidance initiatives across the Cays.</p>
                <a class="footer-sponsor-button" href="https://www.buymeacoffee.com/caynetic" target="_blank" rel="noopener noreferrer" aria-label="Buy Serve the Cays a Kalik through Buy Me a Coffee (opens in a new tab)"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20STC%20a%20kalik&amp;emoji=%F0%9F%8D%BA&amp;slug=caynetic&amp;button_colour=FFDD00&amp;font_colour=000000&amp;font_family=Lato&amp;outline_colour=000000&amp;coffee_colour=ffffff" width="235" height="50" alt="Buy STC a Kalik" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>
            </div>
            <div class="footer-section">
                <h3>Quick Links</h3>
                <ul>
                    <li><a href="/organizations">Organizations</a></li>
                    <li><a href="/events">Events</a></li>
                    <li><a href="/news">News</a></li>
                    <li><a href="/about">About</a></li>
                    <li><a href="/privacy">Privacy Policy</a></li>
                    <li><a class="footer-source-link" href="https://github.com/caynetic/stc" target="_blank" rel="noopener noreferrer"><svg class="footer-github-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.45-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.04 0-.89.31-1.63.82-2.2-.08-.21-.36-1.04.08-2.17 0 0 .67-.22 2.2.84A7.4 7.4 0 0 1 8 3.76c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.13.16 1.96.08 2.17.51.57.82 1.3.82 2.2 0 3.14-1.87 3.83-3.65 4.04.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.47.55.39A8.01 8.01 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"></path></svg><span>Source code</span></a></li>
                </ul>
            </div>
            <div class="footer-section">
                <h4>Contact Info</h4>
                <p><i class="fas fa-envelope" aria-hidden="true"></i> <a href="mailto:hello@servethecays.com">hello@servethecays.com</a></p>
            </div>
        </div>
        <div class="footer-bottom">
            <p>&copy; 2026 Serve the Cays. All rights reserved.</p>
            <p>Operated by <a href="https://caynetic.ltd" target="_blank" rel="noopener noreferrer">Caynetic Ltd.</a></p>
            <p class="footer-cloudflare-credit"><span>Powered by</span><a href="https://www.cloudflare.com/" target="_blank" rel="noopener noreferrer"><i class="fab fa-cloudflare" aria-hidden="true"></i><span>Cloudflare</span></a></p>
        </div>
    </footer>

    <script src="/static/js/script.js"></script>
    <script src="/assets/app.js" type="module"></script>
    ${options.extraBody ?? ""}
</body>
</html>`;
  const response = html(body, 200, options.noindex ? "no-store" : "public, max-age=60, stale-while-revalidate=300");
  if (options.referrerPolicy) response.headers.set("Referrer-Policy", options.referrerPolicy);
  return response;
}

function adminLayout(options: LayoutOptions): Response {
  const origin = expectedOrigin(options.env);
  const canonical = `${origin}${options.path}`;
  const turnstileScript = options.turnstile && options.env.TURNSTILE_SITE_KEY
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : "";
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <meta name="description" content="${escapeHtml(options.description)}">
  <meta name="robots" content="noindex, nofollow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <link rel="icon" type="image/x-icon" href="/static/images/favicon.ico">
  <link rel="stylesheet" href="/static/css/style.css">
  <link rel="stylesheet" href="/static/css/flash.css">
  <link rel="stylesheet" href="/assets/styles.css">
  ${turnstileScript}
</head>
<body class="admin-surface" data-environment="${escapeHtml(options.env.ENVIRONMENT ?? "unknown")}">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="stc-simple-header">
    <nav class="stc-simple-nav" aria-label="Primary navigation">
      <div class="nav-links">
        <a href="/">Home</a>
        <a href="/organizations">Organizations</a>
        <a href="/events">Events</a>
        <a href="/news">News</a>
        <a href="/about">About</a>
        <a href="/admin" class="login-btn" aria-current="page">Admin</a>
      </div>
    </nav>
    <button class="hamburger" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="mobile-navigation">
      <span></span><span></span><span></span>
    </button>
    <nav class="mobile-menu" id="mobile-navigation" aria-label="Mobile navigation">
      <a href="/">Home</a>
      <a href="/organizations">Organizations</a>
      <a href="/events">Events</a>
      <a href="/news">News</a>
      <a href="/about">About</a>
      <a href="/admin" aria-current="page">Admin</a>
    </nav>
  </header>
  <main id="main-content">${options.body}</main>
  <footer class="footer" role="contentinfo">
    <div class="footer-content">
      <div class="footer-section"><h3>Serve the Cays</h3><p>Connecting the community with volunteer opportunities, mentorship programs, and guidance initiatives across the Cays.</p><a class="footer-sponsor-button" href="https://www.buymeacoffee.com/caynetic" target="_blank" rel="noopener noreferrer" aria-label="Buy Serve the Cays a Kalik through Buy Me a Coffee (opens in a new tab)"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20STC%20a%20kalik&amp;emoji=%F0%9F%8D%BA&amp;slug=caynetic&amp;button_colour=FFDD00&amp;font_colour=000000&amp;font_family=Lato&amp;outline_colour=000000&amp;coffee_colour=ffffff" width="235" height="50" alt="Buy STC a Kalik" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a></div>
      <div class="footer-section"><h3>Quick Links</h3><ul><li><a href="/organizations">Organizations</a></li><li><a href="/events">Events</a></li><li><a href="/news">News</a></li><li><a href="/about">About</a></li><li><a href="/privacy">Privacy Policy</a></li><li><a class="footer-source-link" href="https://github.com/caynetic/stc" target="_blank" rel="noopener noreferrer"><svg class="footer-github-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.45-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.04 0-.89.31-1.63.82-2.2-.08-.21-.36-1.04.08-2.17 0 0 .67-.22 2.2.84A7.4 7.4 0 0 1 8 3.76c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.13.16 1.96.08 2.17.51.57.82 1.3.82 2.2 0 3.14-1.87 3.83-3.65 4.04.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.47.55.39A8.01 8.01 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"></path></svg><span>Source code</span></a></li></ul></div>
      <div class="footer-section"><h4>Contact Info</h4><p><a href="mailto:hello@servethecays.com">hello@servethecays.com</a></p></div>
    </div>
    <div class="footer-bottom"><p>&copy; 2026 Serve the Cays. All rights reserved.</p><p>Operated by <a href="https://caynetic.ltd" target="_blank" rel="noopener noreferrer">Caynetic Ltd.</a></p></div>
  </footer>
  <script src="/assets/admin.js" type="module"></script>
</body>
</html>`;
  return html(body, 200, "no-store");
}

function layout(options: LayoutOptions): Response {
  return options.admin ? adminLayout(options) : publicLayout(options);
}

function notice(): string {
  return '<div class="form-status" role="status" aria-live="polite" hidden></div>';
}

const placeholderIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 1H5C3.89 1 3 1.89 3 3V21C3 22.11 3.89 23 5 23H19C20.11 23 21 22.11 21 21V9M19 9H14V4H19V9M7 11H17V13H7V11M7 15H17V17H7V15M7 19H13V21H7V19Z"/></svg>';

function cardMedia(value: Record<string, unknown>, kind: "org" | "event"): string {
  const url = text(value, "image_url");
  const name = text(value, "name");
  if (!url) return `<div class="${kind}-logo-container">${placeholderIcon}</div>`;
  return `<div class="${kind}-logo-container"><img src="${escapeHtml(url)}" alt="${escapeHtml(text(value, "image_alt") || `${name} Logo`)}" class="${kind}-logo" loading="lazy" decoding="async"></div>`;
}

const EVENT_ICON_RULES = [
  { keywords: ["golf"], icon: "fa-golf-ball-tee", label: "Golf fundraiser" },
  { keywords: ["food", "feeding", "hunger", "meal", "plates", "culinary", "pantry"], icon: "fa-utensils", label: "Food service" },
  { keywords: ["wahoo", "fish", "fishing", "angler"], icon: "fa-fish", label: "Fishing fundraiser" },
  { keywords: ["run", "race", "marathon", "5k", "10k"], icon: "fa-person-running", label: "Community run" },
  { keywords: ["chaplain", "class", "training", "workshop", "education", "mentorship"], icon: "fa-graduation-cap", label: "Training and mentorship" },
  { keywords: ["bible", "prayer", "worship", "church", "ministry", "faith"], icon: "fa-hands-praying", label: "Faith gathering" },
  { keywords: ["fellowship", "rotary", "networking"], icon: "fa-users", label: "Community fellowship" },
  { keywords: ["volunteer", "service", "charity", "fundraiser", "donation"], icon: "fa-hand-holding-heart", label: "Volunteer service" },
] as const;

function eventIcon(value: Record<string, unknown>): string {
  const searchable = `${text(value, "name")} ${text(value, "description")} ${text(value, "details")}`.toLowerCase();
  const words = new Set(searchable.match(/[a-z0-9]+/g) ?? []);
  const match = EVENT_ICON_RULES.find((rule) => rule.keywords.some((keyword) => words.has(keyword))) ?? {
    icon: "fa-calendar-check",
    label: "Community event",
  };
  return `<div class="event-icon-container" role="img" aria-label="${escapeHtml(match.label)}"><i class="fas ${match.icon}" aria-hidden="true"></i></div>`;
}

function detailMedia(value: Record<string, unknown>): string {
  const url = text(value, "image_url");
  if (!url) return "";
  return `<div class="entity-logo-large"><img src="${escapeHtml(url)}" alt="${escapeHtml(text(value, "image_alt") || `${text(value, "name")} Logo`)}"></div>`;
}

function formGroup(label: string, control: string, help = ""): string {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const helpId = `${id}-help`;
  const labelledControl = control.replace(/^<([a-z]+)/, `<$1 id="${id}"${help ? ` aria-describedby="${helpId}"` : ""}`);
  return `<div class="form-group"><label for="${id}">${label}</label>${labelledControl}${help ? `<small id="${helpId}">${help}</small>` : ""}</div>`;
}

function multiChoiceGroup(
  legend: string,
  name: string,
  options: Array<{ id: string; label: string }>,
  help: string,
): string {
  const id = `field-${legend.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const helpId = `${id}-help`;
  const choices = options.map((option, index) => {
    const optionId = `${id}-${index + 1}`;
    return `<label class="member-multi-choice-option" for="${optionId}"><input id="${optionId}" name="${escapeHtml(name)}" type="checkbox" value="${escapeHtml(option.id)}" aria-describedby="${helpId}"><span>${escapeHtml(option.label)}</span></label>`;
  }).join("");
  return `<fieldset class="form-group member-multi-choice-group" data-searchable-choices data-choice-name="${escapeHtml(name)}"><legend>${escapeHtml(legend)}</legend><small id="${helpId}">${escapeHtml(help)}</small><label class="member-choice-search-label" for="${id}-search">Search ${escapeHtml(legend.toLowerCase())}</label><input class="form-control member-choice-search" id="${id}-search" type="search" inputmode="search" autocomplete="off" placeholder="Type to filter ${escapeHtml(legend.toLowerCase())}" data-choice-search><div class="member-choice-chips" data-choice-chips aria-live="polite"></div><div class="choice-grid member-multi-choice-grid" data-choice-options>${choices}</div><p class="member-choice-status" data-choice-status role="status" aria-live="polite"></p></fieldset>`;
}

function wizardProgress(labels: string[]): string {
  return `<nav class="member-wizard-progress" aria-label="Suggestion progress"><ol>${labels.map((label, index) => `<li data-wizard-indicator="${index + 1}"${index === 0 ? ' aria-current="step"' : ""}><span>${index + 1}</span><strong>${escapeHtml(label)}</strong></li>`).join("")}</ol></nav>`;
}

function wizardStep(index: number, title: string, content: string): string {
  return `<section class="member-wizard-step" data-wizard-step="${index}" aria-labelledby="member-wizard-step-${index}"${index === 1 ? "" : " hidden"}><header class="member-wizard-step-heading"><span>Step ${index} of 4</span><h2 id="member-wizard-step-${index}" tabindex="-1">${escapeHtml(title)}</h2></header>${content}<div class="member-wizard-actions">${index > 1 ? '<button class="btn member-secondary-button" type="button" data-wizard-back>Back</button>' : '<a class="btn member-secondary-button" href="/me#suggestions">Cancel</a>'}${index < 4 ? '<button class="btn member-primary-button" type="button" data-wizard-next>Continue</button>' : ""}</div></section>`;
}

function wizardReview(submitLabel: string, turnstileMarkup: string): string {
  return `<div class="member-wizard-review" data-wizard-review><div class="member-wizard-review-heading"><div><span class="member-panel-kicker">Final review</span><h3>Check what you are sending</h3><p>Public listing details remain a draft until the STC review team approves them. Private review details never appear on the public card.</p></div></div><dl data-wizard-review-fields></dl></div>${turnstileMarkup}<button type="submit" class="btn member-primary-button">${escapeHtml(submitLabel)}</button>${notice()}<a class="member-suggestion-success-link" href="/me#suggestions" data-submission-success-link hidden>View My suggestions <i class="fas fa-arrow-right" aria-hidden="true"></i></a>`;
}

function memberSubmissionContactFields(): string {
  return `<div class="member-review-contact">
      <span class="member-review-contact-icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
      <div><strong>Private review contact</strong><p>We’ll use the verified email address attached to your My STC account. It stays private and is never copied into the public listing.</p></div>
    </div>
    ${formGroup("Private Review Phone (Optional)", '<input class="form-control" name="submitter_phone" type="tel" maxlength="50" placeholder="Phone Number" autocomplete="tel" inputmode="tel">', "Add a phone number only if the review team may use it to follow up about this suggestion.")}
    <div class="form-section-label">Public contact information <span>(optional)</span></div>
    ${formGroup("Public Email", '<input class="form-control" name="public_email" type="email" maxlength="254" placeholder="Public Email Address" autocomplete="off" inputmode="email">')}
    ${formGroup("Public Phone", '<input class="form-control" name="public_phone" type="tel" maxlength="50" placeholder="Public Phone Number" autocomplete="off" inputmode="tel">', "Only enter contact details you want displayed after approval.")}`;
}

function organizationContactRow(): string {
  return `<fieldset class="organization-contact-form-row" data-organization-contact-row>
    <legend>Additional public contact</legend>
    <div class="organization-contact-fields">
      <label>Type<select class="form-control" name="contact_type" autocomplete="off"><option value="">Choose one</option><option value="email">Email</option><option value="phone">Phone</option></select></label>
      <label>Label<input class="form-control" name="contact_label" maxlength="80" placeholder="e.g. Volunteer team" autocomplete="off"></label>
      <label>Contact detail<input class="form-control" name="contact_value" maxlength="254" placeholder="Email address or phone number" autocomplete="off"></label>
    </div>
    <button class="organization-contact-remove" type="button" data-remove-organization-contact>Remove contact</button>
  </fieldset>`;
}

function organizationProfileFields(): string {
  return `<fieldset class="organization-profile-fields">
    <legend>More about the organization <span>(optional)</span></legend>
    <p>Add only the sections that will help people understand the organization. Empty sections will not appear publicly.</p>
    ${formGroup("Mission", '<textarea class="form-control" name="mission" maxlength="3000" placeholder="What is the organization working to achieve?" rows="4" autocomplete="off"></textarea>')}
    ${formGroup("Programs & Services", '<textarea class="form-control" name="programs_services" maxlength="5000" placeholder="Describe programs, services, or regular activities." rows="5" autocomplete="off"></textarea>')}
    ${formGroup("Ways to Help", '<textarea class="form-control" name="ways_to_help" maxlength="3000" placeholder="Volunteer roles, donation needs, skills, or materials that would help." rows="4" autocomplete="off"></textarea>')}
    ${formGroup("Who Can Participate", '<textarea class="form-control" name="eligibility" maxlength="2000" placeholder="Age, eligibility, registration, accessibility, or other participation details." rows="4" autocomplete="off"></textarea>')}
    ${formGroup("Hours & Availability", '<textarea class="form-control" name="hours" maxlength="1000" placeholder="Office hours, program schedule, or best times to contact the team." rows="3" autocomplete="off"></textarea>')}
  </fieldset>`;
}

function organizationAdditionalContacts(): string {
  return `<fieldset class="organization-contact-editor" data-organization-contact-editor>
    <legend>Additional public emails and phone numbers <span>(optional)</span></legend>
    <p>Use labels such as General inquiries, Volunteer coordinator, Programs, Media, or Donations. These details become public only after approval.</p>
    <div data-organization-contact-list>${organizationContactRow()}</div>
    <button class="btn member-secondary-button organization-contact-add" type="button" data-add-organization-contact><i class="fas fa-plus" aria-hidden="true"></i> Add another public contact</button>
    <template data-organization-contact-template>${organizationContactRow()}</template>
  </fieldset>`;
}

function imageFields(label: string): string {
  return `
    <div class="form-section-label">${escapeHtml(label)} <span>(optional)</span></div>
    ${formGroup("Choose Image", '<input class="form-control" type="file" name="image" accept="image/jpeg,image/png,image/webp">', "One JPEG, PNG, or WebP image, up to 5 MiB. It stays private until the complete listing is approved.")}
    ${formGroup("Image Description", '<input class="form-control" type="text" name="image_alt" maxlength="300" placeholder="Describe the image for someone who cannot see it">')}`;
}

export async function homePage(env: Env): Promise<Response> {
  const latestNews = await env.DB.prepare(
    `SELECT slug, title, summary, published_at
     FROM news_posts WHERE status = 'published' AND published_at <= ?
     ORDER BY published_at DESC, id DESC LIMIT 3`,
  ).bind(new Date().toISOString()).all<Record<string, unknown>>();
  const newsSection = latestNews.results.length
    ? `<section class="news-home-section" aria-labelledby="latest-news-title"><div class="container"><div class="news-section-heading"><div><span class="news-eyebrow">From Serve the Cays</span><h2 id="latest-news-title">Latest news</h2></div><a href="/news">View all news</a></div><div class="news-grid">${latestNews.results.map(newsCard).join("")}</div></div></section>`
    : "";
  const body = `<div class="container hero-container stc-simple-hero">
    <picture class="home-logo">
        <source media="(prefers-reduced-motion: no-preference)" srcset="/assets/logo-animated-v1.svg" type="image/svg+xml">
        <img src="/static/images/logo.svg" alt="Serve the Cays Logo" class="logo" width="200" height="200">
    </picture>
    <section class="hero">
        <h1>Welcome to Serve the Cays</h1>
        <p>Connecting you with volunteer opportunities, mentorship programs, and community guidance initiatives to make a difference across the Bahamas. Join our community of changemakers.</p>
        <div class="cta-buttons">
            <a href="/organizations" class="btn">Find Organizations</a>
            <a href="/events" class="btn">Discover Events</a>
        </div>
    </section>
</div>
<section class="features stc-simple-features" id="features">
    <div class="container">
        <h2>How We Help</h2>
        <div class="feature-grid">
            <div class="feature-card"><h3>Connect</h3><p>Find volunteer and mentorship opportunities that match your interests and skills.</p></div>
            <div class="feature-card"><h3>Organize</h3><p>List your organization or program and reach passionate individuals in the community.</p></div>
            <div class="feature-card"><h3>Impact</h3><p>Make a real difference through meaningful community service and guidance.</p></div>
            <div class="feature-card"><h3>Engage</h3><p>Save organizations, RSVP to events, and stay connected with the causes you care about.</p></div>
        </div>
    </div>
</section>
${newsSection}
<div class="container">
    <section class="newsletter" id="newsletter">
        <h2>Stay Connected</h2>
        <p>Get updates on new programs, volunteer opportunities, and community events delivered to your inbox.</p>
        <form class="newsletter-form" data-newsletter-form autocomplete="on">
            <label class="sr-only" for="newsletter-email">Email address</label>
            <input id="newsletter-email" name="email" placeholder="Enter your email" required type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false">
            <input class="honeypot" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
            ${turnstile(env, "newsletter_subscribe")}
            <button type="submit">Subscribe</button>
            ${notice()}
        </form>
    </section>
</div>`;
  return layout({ env, path: "/", title: "Serve the Cays - Community & Volunteer Directory", description: "Directory for volunteer organizations, mentorship programs, and community events across the Bahamas.", keywords: "volunteer, mentorship, youth, guidance, bahamas, community, organizations, events, service, directory", body, turnstile: true });
}

export async function newsPage(env: Env): Promise<Response> {
  const posts = await env.DB.prepare(
    `SELECT slug, title, summary, published_at
     FROM news_posts WHERE status = 'published' AND published_at <= ?
     ORDER BY published_at DESC, id DESC LIMIT 100`,
  ).bind(new Date().toISOString()).all<Record<string, unknown>>();
  const body = `<section class="news-index"><div class="container">
    <header class="news-index-heading"><span class="news-eyebrow">Community updates</span><h1>News from Serve the Cays</h1><p>Updates, stories, and useful information from organizations and community-service efforts across The Bahamas.</p></header>
    ${posts.results.length
      ? `<div class="news-grid">${posts.results.map(newsCard).join("")}</div>`
      : '<div class="news-empty"><h2>News is on the way</h2><p>Check back soon for community updates and stories.</p></div>'}
  </div></section>`;
  return layout({
    env,
    path: "/news",
    title: "News - Serve the Cays",
    description: "Community updates, stories, and news from Serve the Cays across The Bahamas.",
    keywords: "Bahamas community news, volunteer updates, nonprofit stories, Serve the Cays",
    body,
  });
}

export async function newsPostPage(env: Env, slug: string): Promise<Response> {
  const post = await env.DB.prepare(
    `SELECT slug, title, summary, body_text, published_at, updated_at
     FROM news_posts
     WHERE slug = ? AND status = 'published' AND published_at <= ?`,
  ).bind(slug, new Date().toISOString()).first<Record<string, unknown>>();
  if (!post) return notFoundPage(env);
  const paragraphs = text(post, "body_text")
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const origin = expectedOrigin(env);
  const structuredData = jsonLd({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: text(post, "title"),
    description: text(post, "summary"),
    datePublished: text(post, "published_at"),
    dateModified: text(post, "updated_at"),
    mainEntityOfPage: `${origin}/news/${text(post, "slug")}`,
    publisher: { "@type": "Organization", name: "Serve the Cays", url: origin },
  });
  const body = `<article class="news-article"><div class="container news-article-container">
    <a class="news-back" href="/news"><span aria-hidden="true">←</span> All news</a>
    <header><span class="news-eyebrow">Serve the Cays news</span><h1>${escapeHtml(text(post, "title"))}</h1><p class="news-article-summary">${escapeHtml(text(post, "summary"))}</p><p class="news-article-date"><time datetime="${escapeHtml(text(post, "published_at"))}">${escapeHtml(publicDate(post.published_at))}</time></p></header>
    <div class="news-article-body">${paragraphs}</div>
  </div></article>`;
  return layout({
    env,
    path: `/news/${text(post, "slug")}`,
    title: `${text(post, "title")} - Serve the Cays`,
    description: text(post, "summary"),
    keywords: "Bahamas community news, volunteer updates, Serve the Cays",
    body,
    extraHead: structuredData,
  });
}

export async function organizationsPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [organizations, locations, categories] = await Promise.all([
    organizationListData(env, url),
    env.DB.prepare("SELECT id, slug, city, island FROM locations WHERE is_active = 1 ORDER BY city").all<LocationRow>(),
    env.DB.prepare("SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name").all<CategoryRow>(),
  ]);
  const cards = organizations.map((organization) => {
    const locationsList = array(organization, "locations");
    const categoriesList = array(organization, "categories");
    const customLocation = text(organization, "custom_location");
    const name = text(organization, "name");
    return `<article class="org-card">
        ${memberFavoriteButton("organization", organization.id, name)}
        ${cardMedia(organization, "org")}
        <h2>${escapeHtml(name)}</h2>
        <p>${escapeHtml(text(organization, "description"))}</p>
        <div class="org-locations">${locationsList.map((location) => `<span class="org-location-tag">${escapeHtml(text(location, "city"))}, ${escapeHtml(text(location, "island"))}</span>`).join("")}${customLocation ? `<span class="org-location-tag">${escapeHtml(customLocation)}</span>` : ""}</div>
        <div class="org-categories">${categoriesList.map((category) => `<span class="category-tag">${escapeHtml(text(category, "name"))}</span>`).join("")}</div>
        <a class="card-cta" href="/organization/${encodeURIComponent(text(organization, "slug"))}">Learn More</a>
    </article>`;
  }).join("");
  const cities = [...new Set(locations.results.map((location) => location.city))];
  const search = url.searchParams.get("search") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const category = url.searchParams.get("category") ?? "";
  const body = `<div class="container">
    <h1>Community Programs &amp; Organizations</h1>
    <p>Discover organizations, mentorship programs, and guidance initiatives across the Bahamas that are making a difference.</p>
    <div class="search-sort">
        <form action="/organizations" method="GET" class="search-form">
            <input type="search" name="search" aria-label="Search organizations" placeholder="Search programs..." value="${escapeHtml(search)}">
            <select name="city" aria-label="Filter organizations by city"><option value="">All Cities</option>${cities.map((item) => `<option value="${escapeHtml(item)}"${city === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
            <select name="category" aria-label="Filter organizations by category"><option value="">All Categories</option>${categories.results.map((item) => `<option value="${escapeHtml(item.slug)}"${category === item.slug ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select>
            <button type="submit" class="btn">Search</button>
        </form>
    </div>
    <p class="results-summary" role="status"><strong>${organizations.length}</strong> ${organizations.length === 1 ? "organization" : "organizations"} found</p>
    <div class="org-grid" id="org-grid">${cards || '<div class="directory-empty"><h2>No organizations found</h2><p>Try a broader search or clear the current filters.</p><a href="/organizations" class="btn">Clear filters</a></div>'}</div>
</div>`;
  return layout({ env, path: "/organizations", title: "Programs & Organizations - Serve the Cays", description: "Discover volunteer organizations, mentorship programs, and community initiatives across the Bahamas.", body, extraHead: '<link rel="stylesheet" href="/static/css/list.css">' });
}

export async function organizationPage(env: Env, slug: string): Promise<Response> {
  const organization = await organizationData(env, slug);
  const locations = array(organization, "locations");
  const categories = array(organization, "categories");
  const publicContacts = array(organization, "public_contacts");
  const sections = array(organization, "sections");
  const customLocation = text(organization, "custom_location");
  const name = text(organization, "name");
  const publicEmail = text(organization, "public_email");
  const publicPhone = text(organization, "public_phone");
  const website = text(organization, "website");
  const hasMedia = Boolean(text(organization, "image_url"));
  const contacts = publicContacts.length
    ? publicContacts
    : [
        ...(publicEmail ? [{ type: "email", label: "General inquiries", value: publicEmail, is_primary: true }] : []),
        ...(publicPhone ? [{ type: "phone", label: "General inquiries", value: publicPhone, is_primary: true }] : []),
      ];
  const primaryEmail = contacts.find((contact) => text(contact, "type") === "email" && boolean(contact, "is_primary"))
    ?? contacts.find((contact) => text(contact, "type") === "email");
  const primaryPhone = contacts.find((contact) => text(contact, "type") === "phone" && boolean(contact, "is_primary"))
    ?? contacts.find((contact) => text(contact, "type") === "phone");
  const primaryEmailValue = primaryEmail ? text(primaryEmail, "value") : publicEmail;
  const primaryPhoneValue = primaryPhone ? text(primaryPhone, "value") : publicPhone;
  const locationFilters = locations.map((location) => ({
    label: `${text(location, "city")}, ${text(location, "island")}`,
    href: `/organizations?city=${encodeURIComponent(text(location, "city"))}`,
  }));
  const locationItems = [
    ...locationFilters.map((location) => location.label),
    ...(customLocation ? [customLocation] : []),
  ];
  const upcomingEvents = array(organization, "upcoming_events");
  const upcomingEventsMarkup = upcomingEvents.length
    ? `<div class="member-linked-list">${upcomingEvents.map((event) => `<a class="member-linked-card" href="/event/${number(event, "id")}"><strong>${escapeHtml(text(event, "name"))}</strong><span>${escapeHtml(formatEventDate(text(event, "start_at")))}</span><span>${escapeHtml(text(event, "venue_name"))}${text(event, "location_display") ? ` · ${escapeHtml(text(event, "location_display"))}` : ""}</span></a>`).join("")}</div>`
    : '<p class="organization-empty">No upcoming linked events are listed right now.</p>';
  const contactMarkup = contacts.map((contact) => {
    const type = text(contact, "type");
    const label = text(contact, "label") || (type === "email" ? "Email" : "Phone");
    const value = text(contact, "value");
    if (!value || (type !== "email" && type !== "phone")) return "";
    const href = type === "email"
      ? `mailto:${escapeHtml(value)}`
      : `tel:${escapeHtml(value.replace(/[^+0-9]/g, ""))}`;
    const action = type === "email" ? `Email ${label}` : `Call ${label}`;
    const icon = type === "email" ? "fa-envelope" : "fa-phone";
    return `<li class="organization-contact-row"><span class="organization-contact-icon" aria-hidden="true"><i class="fas ${icon}"></i></span><div><a href="${href}">${escapeHtml(action)}</a><span>${escapeHtml(value)}</span></div></li>`;
  }).join("");
  const focusMetaMarkup = categories.length
    ? `<div class="organization-meta-group"><span class="organization-meta-label">Focus</span>${categories.map((category) => `<a class="organization-meta-chip" href="/organizations?category=${encodeURIComponent(text(category, "slug"))}">${escapeHtml(text(category, "name"))}</a>`).join("")}</div>`
    : "";
  const locationMetaMarkup = locationFilters.length || customLocation
    ? `<div class="organization-meta-group"><span class="organization-meta-label">Location</span>${locationFilters.map((location) => `<a class="organization-meta-chip" href="${escapeHtml(location.href)}">${escapeHtml(location.label)}</a>`).join("")}${customLocation ? `<span class="organization-meta-chip">${escapeHtml(customLocation)}</span>` : ""}</div>`
    : "";
  const profileSections = sections.map((section) => `
    <section class="organization-section">
      <h2>${escapeHtml(text(section, "heading"))}</h2>
      <p class="organization-section-copy">${escapeHtml(text(section, "body"))}</p>
    </section>`).join("");
  const hasWaysToHelp = sections.some((section) => text(section, "kind") === "ways_to_help");
  const structuredOrganization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    description: text(organization, "description"),
    url: website || `${expectedOrigin(env)}/organization/${encodeURIComponent(slug)}`,
    email: primaryEmailValue || undefined,
    telephone: primaryPhoneValue || undefined,
    areaServed: locationItems,
    contactPoint: contacts.map((contact) => ({
      "@type": "ContactPoint",
      contactType: text(contact, "label"),
      email: text(contact, "type") === "email" ? text(contact, "value") : undefined,
      telephone: text(contact, "type") === "phone" ? text(contact, "value") : undefined,
    })),
  };
  const body = `<div class="container organization-profile">
    <a class="organization-breadcrumb" href="/organizations"><i class="fas fa-arrow-left" aria-hidden="true"></i> All organizations</a>
    <header class="organization-hero${hasMedia ? "" : " organization-hero-no-media"}">
      ${detailMedia(organization)}
      <div class="organization-hero-copy">
        <div class="organization-title-row"><div><h1>${escapeHtml(name)}</h1></div>${memberFavoriteButton("organization", organization.id, name, true)}</div>
        <p class="org-description">${escapeHtml(text(organization, "description"))}</p>
        ${focusMetaMarkup || locationMetaMarkup ? `<div class="organization-meta">${focusMetaMarkup}${locationMetaMarkup}</div>` : ""}
        <div class="organization-actions">
          ${website ? `<a href="${escapeHtml(website)}" class="btn" target="_blank" rel="noopener noreferrer">Visit official website <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ""}
          ${contactMarkup ? `<a href="#contact" class="btn organization-contact-action">Contact organization <i class="fas fa-arrow-down" aria-hidden="true"></i></a>` : ""}
        </div>
      </div>
    </header>
    <div class="organization-layout${contactMarkup ? "" : " organization-layout-no-sidebar"}">
      <main class="organization-main">
        <section class="organization-section organization-about">
          <h2>About ${escapeHtml(name)}</h2>
          <p class="organization-section-copy">${escapeHtml(text(organization, "details") || text(organization, "description"))}</p>
        </section>
        ${profileSections}
        ${hasWaysToHelp ? "" : `<section class="organization-section"><h2>Get Involved</h2><p>Interested in volunteering with ${escapeHtml(name)}? Confirm current opportunities and participation requirements directly with the organization through its official website or listed contact information.</p></section>`}
        <section class="organization-section">
          <h2>Upcoming Events</h2>
          ${upcomingEventsMarkup}
        </section>
      </main>
      ${contactMarkup ? `<aside class="organization-sidebar" aria-label="Organization information"><section id="contact" class="organization-sidebar-panel organization-contact-panel"><h2>Contact</h2><ul class="organization-contact-list">${contactMarkup}</ul></section></aside>` : ""}
    </div>
    <div class="organization-return-row"><a href="/organizations" class="organization-return-link"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to organizations</a></div>
  </div>`;
  return layout({
    env,
    path: `/organization/${encodeURIComponent(slug)}`,
    title: `${name} - Serve the Cays`,
    description: text(organization, "description"),
    keywords: `${name}, volunteer, bahamas, community, ${locations.map((location) => text(location, "city")).join(", ")}`,
    body,
    extraHead: `<link rel="stylesheet" href="/static/css/entity.css">${jsonLd(structuredOrganization)}`,
  });
}

function formatEventDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-BS", { dateStyle: "long", timeStyle: "short", timeZone: "America/Nassau" }).format(parsed);
}

export async function eventsPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [events, locations] = await Promise.all([
    eventListData(env, url),
    env.DB.prepare("SELECT id, slug, city, island FROM locations WHERE is_active = 1 ORDER BY city").all<LocationRow>(),
  ]);
  const cards = events.map((event) => {
    const name = text(event, "name");
    const startAt = text(event, "start_at");
    return `<article class="event-card">
      ${memberFavoriteButton("event", event.id, name)}
      ${eventIcon(event)}
      <h2>${escapeHtml(name)}</h2>
      <div class="date"><time datetime="${escapeHtml(startAt)}">${escapeHtml(formatEventDate(startAt))}</time></div>
      <div class="event-location-tag">${escapeHtml(text(event, "venue_name"))} - ${escapeHtml(text(event, "location_display"))}</div>
      <div class="member-rsvp-count"><i class="fas fa-user-check" aria-hidden="true"></i> <span>${number(event, "rsvp_count")}</span> going</div>
      <p>${escapeHtml(text(event, "description"))}</p>
      <a class="card-cta" href="/event/${Number(event.id)}" aria-label="Learn more about ${escapeHtml(name)}">Learn More</a>
  </article>`;
  }).join("");
  const cities = [...new Set(locations.results.map((location) => location.city))];
  const search = url.searchParams.get("search") ?? "";
  const city = url.searchParams.get("city") ?? "";
  const body = `<div class="container">
    <h1>Upcoming Volunteer &amp; Community Events in The Bahamas</h1>
    <p>Find future volunteer opportunities, charity events, community-service projects, faith fellowships, and mentorship activities across The Bahamas.</p>
    <div class="search-sort"><form action="/events" method="GET" class="search-form">
        <input type="search" name="search" aria-label="Search events" placeholder="Search events..." value="${escapeHtml(search)}">
        <select name="city" aria-label="Filter events by city"><option value="">All Cities</option>${cities.map((item) => `<option value="${escapeHtml(item)}"${city === item ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
        <button type="submit" class="btn">Search</button>
    </form></div>
    <p class="results-summary" role="status"><strong>${events.length}</strong> ${events.length === 1 ? "event" : "events"} found</p>
    <div class="event-grid" id="event-grid">${cards || '<div class="directory-empty"><h2>No events found</h2><p>Try a broader search or clear the current filters.</p><a href="/events" class="btn">Clear filters</a></div>'}</div>
</div>`;
  return layout({
    env,
    path: "/events",
    title: "Upcoming Volunteer Events in The Bahamas | Serve the Cays",
    description: "Find upcoming volunteer opportunities, charity events, community-service projects, faith fellowships, and mentorship activities across The Bahamas.",
    keywords: "upcoming Bahamas events, volunteer opportunities Bahamas, charity events Bahamas, community service, fellowship events, mentorship activities",
    body,
    extraHead: '<link rel="stylesheet" href="/static/css/list.css">',
  });
}

export async function eventPage(env: Env, id: number): Promise<Response> {
  const event = await eventData(env, id);
  const name = text(event, "name");
  const publicEmail = text(event, "public_email");
  const publicPhone = text(event, "public_phone");
  const website = text(event, "website");
  const startAt = text(event, "start_at");
  const endAt = text(event, "end_at");
  const venueName = text(event, "venue_name");
  const locationDisplay = text(event, "location_display");
  const imageUrl = text(event, "image_url");
  const organizations = array(event, "organizations");
  const rsvpCount = number(event, "rsvp_count");
  const effectiveEnd = endAt || startAt;
  const ended = boolean(event, "ended") || (Boolean(effectiveEnd) && Date.parse(effectiveEnd) <= Date.now());
  const canonical = `${expectedOrigin(env)}/event/${id}`;
  const structuredEvent: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Event",
    name,
    description: text(event, "description"),
    startDate: startAt,
    eventStatus: ended ? "https://schema.org/EventCompleted" : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    url: canonical,
    location: {
      "@type": "Place",
      name: venueName,
      ...(locationDisplay ? { address: locationDisplay } : {}),
    },
  };
  if (endAt) structuredEvent.endDate = endAt;
  if (imageUrl) structuredEvent.image = [`${expectedOrigin(env)}${imageUrl}`];
  const organizers = organizations.filter((organization) => {
    const role = text(organization, "role");
    return role === "host" || role === "organizer";
  });
  if (organizers.length) {
    structuredEvent.organizer = organizers.map((organization) => ({
      "@type": "Organization",
      name: text(organization, "name"),
      url: `${expectedOrigin(env)}/organization/${encodeURIComponent(text(organization, "slug"))}`,
    }));
  }
  const organizationLinks = organizations.length
    ? `<div class="member-linked-list">${organizations.map((organization) => {
      const role = text(organization, "role") || "organizer";
      const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
      return `<a class="member-linked-card" href="/organization/${encodeURIComponent(text(organization, "slug"))}"><strong>${escapeHtml(text(organization, "name"))}${boolean(organization, "is_primary") ? ' <span class="member-badge">Primary</span>' : ""}</strong><span>${escapeHtml(roleLabel)}</span></a>`;
    }).join("")}</div>`
    : "<p>This is a standalone event and is not currently linked to an organization.</p>";
  const memberActions = ended
    ? '<div class="member-event-actions member-event-ended"><strong>This event has ended.</strong><span>Its page remains available as a read-only archive.</span></div>'
    : `<div class="member-event-actions" data-event-member-actions data-event-id="${id}">
        <button class="btn member-rsvp-button" type="button" data-rsvp-event-id="${id}">Sign in to say you&rsquo;re going</button>
        <p class="member-action-status" role="status" aria-live="polite"></p>
      </div>`;
  const body = `<div class="container">
    <div class="entity-header">${detailMedia(event)}${ended ? '<span class="member-badge member-badge-ended">Ended</span>' : ""}<h1>${escapeHtml(name)}</h1></div>
    <p class="event-meta"><i class="far fa-calendar-alt"></i> <time datetime="${escapeHtml(startAt)}">${escapeHtml(formatEventDate(startAt))}</time>${endAt ? `<br><i class="far fa-clock"></i> Ends <time datetime="${escapeHtml(endAt)}">${escapeHtml(formatEventDate(endAt))}</time>` : ""}<br><i class="fas fa-map-marker-alt"></i> ${escapeHtml(venueName)} - ${escapeHtml(locationDisplay)}</p>
    <div class="member-event-summary"><p class="member-rsvp-count"><i class="fas fa-user-check" aria-hidden="true"></i> <strong data-rsvp-count="${id}">${rsvpCount}</strong> <span data-rsvp-count-label="${id}">${rsvpCount === 1 ? "person is" : "people are"}</span> going</p>${memberActions}</div>
    <p class="org-description">${escapeHtml(text(event, "description"))}</p>
    <div class="entity-details">
        <h2>Event Details</h2><p>${escapeHtml(text(event, "details") || text(event, "description"))}</p>
        <h2>Connected Organizations</h2>${organizationLinks}
        <h2>How to Participate</h2><p>Interested in joining this event? Contact the organizer for more information about participation requirements and how to get involved.</p>
        <h2>Contact Information</h2>
        <ul class="contact-list">${publicEmail ? `<li><i class="fas fa-envelope"></i> <a href="mailto:${escapeHtml(publicEmail)}">${escapeHtml(publicEmail)}</a></li>` : ""}${publicPhone ? `<li><i class="fas fa-phone"></i> <a href="tel:${escapeHtml(publicPhone)}">${escapeHtml(publicPhone)}</a></li>` : ""}${website ? `<li><i class="fas fa-link"></i> <a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(website)}</a></li>` : ""}</ul>
        <div class="cta-section"><a href="/events" class="btn">Back to Events</a>${publicEmail ? `<a href="mailto:${escapeHtml(publicEmail)}" class="btn">Contact Organizer</a>` : ""}</div>
    </div>
</div>
<div id="lightbox" class="lightbox" aria-hidden="true"><img id="lightbox-img" alt="Full screen image"></div>`;
  return layout({ env, path: `/event/${id}`, title: `${name} | Serve the Cays`, description: text(event, "description"), keywords: `${name}, ${ended ? "past" : "upcoming"} event, volunteer, community service, The Bahamas, ${venueName}`, body, noindex: ended, extraHead: `<link rel="stylesheet" href="/static/css/entity.css"><style>.event-meta{font-size:1.1rem;color:#666;margin-bottom:1.5rem;line-height:1.8}.event-meta i{width:20px;text-align:center;margin-right:.5rem}.org-description{font-size:1.25rem;color:#333;margin-bottom:2rem;font-weight:500}.entity-logo-large{width:100%;max-width:600px;height:300px;background-color:#f5f5f5;border-radius:8px;overflow:hidden}</style>${jsonLd(structuredEvent)}`, extraBody: '<script src="/static/js/entity.js"></script>' });
}

export async function suggestOrganizationPage(request: Request, env: Env): Promise<Response> {
  const member = await optionalMemberSession(request, env);
  if (!member) return redirect("/signin?return=%2Fsuggest%2Forganization", 303);
  const [locations, categories] = await Promise.all([
    env.DB.prepare("SELECT id, slug, city, island FROM locations WHERE is_active = 1 ORDER BY city").all<LocationRow>(),
    env.DB.prepare("SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name").all<CategoryRow>(),
  ]);
  const body = `<div class="container member-suggestion-shell" data-member-suggestion-page>
    <a class="member-suggestion-back" href="/me#suggestions"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to My suggestions</a>
    <header class="member-suggestion-header">
      <span class="member-eyebrow">My STC contribution</span>
      <h1>Suggest an organization</h1>
      <p>Help the community discover a volunteer organization, mentorship program, or local initiative. Every suggestion is privately reviewed before anything is published.</p>
    </header>
    <form class="contact-form member-suggestion-form member-wizard-form" data-submission-form data-member-required data-submission-wizard data-draft-key="organization" data-endpoint="/api/submissions/organizations" enctype="multipart/form-data" autocomplete="on" aria-busy="true">
        <input class="honeypot" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        ${wizardProgress(["Basics", "Reach & focus", "Contact & logo", "Review"])}
        <p class="member-wizard-draft-status" data-wizard-draft-status role="status" aria-live="polite">Your progress is saved in this browser as you work.</p>
        ${wizardStep(1, "Organization basics", `${formGroup("Organization Name", '<input class="form-control" name="name" required maxlength="200" placeholder="Organization Name" autocomplete="organization">')}${formGroup("Description", '<textarea class="form-control" name="description" required minlength="10" maxlength="500" placeholder="Describe what they do..." rows="5" autocomplete="off"></textarea>')}${formGroup("Website", '<input class="form-control" name="website" maxlength="500" placeholder="https://..." type="url" autocomplete="url" inputmode="url">')}`)}
        ${wizardStep(2, "Where and how they serve", `${multiChoiceGroup("Locations", "location_ids", locations.results.map((location) => ({ id: location.id, label: `${location.city}, ${location.island}` })), "Select every location this organization serves. Each checkbox can be selected independently on desktop or mobile.")}${formGroup("New Location (if not listed)", '<input class="form-control" name="new_location" maxlength="200" placeholder="City, Island" autocomplete="address-level2">')}${multiChoiceGroup("Categories", "category_ids", categories.results.map((category) => ({ id: category.id, label: category.name })), "Select every focus area that applies. Each checkbox can be selected independently on desktop or mobile.")}${formGroup("Additional Details", '<textarea class="form-control" name="details" maxlength="5000" placeholder="A fuller introduction or background for the About section" rows="5" autocomplete="off"></textarea>')}${organizationProfileFields()}`)}
        ${wizardStep(3, "Public contact and logo", `${memberSubmissionContactFields()}${organizationAdditionalContacts()}${imageFields("Organization Logo")}<div class="form-review-note"><strong>Private review:</strong> Your account contact, optional review phone, and original image are never placed in the public listing. Public contact fields and a sanitized image are published only after approval.</div>`)}
        ${wizardStep(4, "Review your organization", wizardReview("Send organization for review", turnstile(env, "submit_organization")))}
    </form>
</div>`;
  return layout({ env, path: "/suggest/organization", title: "Suggest an Organization - Serve the Cays", description: "Suggest a Bahamian volunteer organization or community program for private review.", body, noindex: true, turnstile: true, referrerPolicy: "no-referrer" });
}

export async function suggestEventPage(request: Request, env: Env): Promise<Response> {
  const member = await optionalMemberSession(request, env);
  if (!member) return redirect("/signin?return=%2Fsuggest%2Fevent", 303);
  const [locations, organizations] = await Promise.all([
    env.DB.prepare("SELECT id, slug, city, island FROM locations WHERE is_active = 1 ORDER BY city").all<LocationRow>(),
    env.DB.prepare("SELECT id, name FROM organizations WHERE is_active = 1 ORDER BY name LIMIT 200").all<{ id: string; name: string }>(),
  ]);
  const body = `<div class="container member-suggestion-shell" data-member-suggestion-page>
    <a class="member-suggestion-back" href="/me#suggestions"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to My suggestions</a>
    <header class="member-suggestion-header">
      <span class="member-eyebrow">My STC contribution</span>
      <h1>Suggest an event</h1>
      <p>Share an upcoming community event for private review. You can connect it to one or several active organizations so people can discover everyone involved.</p>
    </header>
    <form class="contact-form member-suggestion-form member-wizard-form" data-submission-form data-member-required data-submission-wizard data-draft-key="event" data-endpoint="/api/submissions/events" enctype="multipart/form-data" autocomplete="on" aria-busy="true">
        <input class="honeypot" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        ${wizardProgress(["Event", "Time & place", "People & details", "Review"])}
        <p class="member-wizard-draft-status" data-wizard-draft-status role="status" aria-live="polite">Your progress is saved in this browser as you work.</p>
        ${wizardStep(1, "Event basics", `${formGroup("Event Name", '<input class="form-control" name="name" required maxlength="200" placeholder="Event Title" autocomplete="off">')}${formGroup("Description", '<textarea class="form-control" name="description" required minlength="10" maxlength="500" placeholder="Event details..." rows="5" autocomplete="off"></textarea>')}`)}
        ${wizardStep(2, "When and where", `${formGroup("Date", '<input class="form-control" name="start_at" type="datetime-local" required autocomplete="off">')}${formGroup("Venue Name", '<input class="form-control" name="venue_name" required maxlength="200" placeholder="Specific Venue Name (e.g. Community Center)" autocomplete="organization">')}${formGroup("Island/City", `<select class="form-control" name="location_id" autocomplete="off"><option value="">Choose a location</option>${locations.results.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.city)}, ${escapeHtml(location.island)}</option>`).join("")}</select>`, "Select the Island/City where this is happening.")}${formGroup("New Location (if not listed)", '<input class="form-control" name="new_location" maxlength="200" placeholder="City, Island" autocomplete="address-level2">')}${formGroup("End Date", '<input class="form-control" name="end_at" type="datetime-local" autocomplete="off">')}`)}
        ${wizardStep(3, "People and participation details", `${multiChoiceGroup("Connected Organizations", "organization_ids", organizations.results.map((organization) => ({ id: organization.id, label: organization.name })), "Choose up to 20 connected organizations. The review team confirms Host, Organizer, Partner, or Beneficiary roles before publishing.")}${memberSubmissionContactFields()}${formGroup("Website", '<input class="form-control" name="website" maxlength="500" placeholder="https://..." type="url" autocomplete="url" inputmode="url">')}${formGroup("Additional Details", '<textarea class="form-control" name="details" maxlength="5000" placeholder="Schedule, participation requirements, accessibility, or what to bring" rows="5" autocomplete="off"></textarea>')}${imageFields("Event Flyer or Photograph")}<div class="form-review-note"><strong>Private review:</strong> We use the verified email attached to your My STC account. Your account contact, optional review phone, and original image stay private. Only approved event details, explicitly public contacts, organization links, and a sanitized image derivative become public.</div>`)}
        ${wizardStep(4, "Review your event", wizardReview("Send event for review", turnstile(env, "submit_event")))}
    </form>
</div>`;
  return layout({ env, path: "/suggest/event", title: "Suggest an Event - Serve the Cays", description: "Suggest an upcoming Bahamian community event for private review.", body, noindex: true, turnstile: true, referrerPolicy: "no-referrer" });
}

export function signInPage(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const returnPath = safeReturnPath(url.searchParams.get("return") ?? "/me");
  const requestedIntent = url.searchParams.get("intent") ?? "";
  const intentType = ["favorite_organization", "favorite_event", "rsvp_event"].includes(requestedIntent) ? requestedIntent : "";
  const rawTarget = (url.searchParams.get("target") ?? "").slice(0, 100);
  const targetId = /^[A-Za-z0-9_-]+$/.test(rawTarget) ? rawTarget : "";
  const actionMessage = intentType === "favorite_organization"
    ? "Sign in to save this organization. We’ll finish that action after you verify your email."
    : intentType === "favorite_event"
      ? "Sign in to save this event. We’ll finish that action after you verify your email."
      : intentType === "rsvp_event"
        ? "Sign in to confirm you’re going. We’ll finish that RSVP after you verify your email."
        : "We’ll email you a secure, one-time sign-in link. No password needed.";
  const body = `<div class="container member-auth-shell">
    <div class="member-auth-layout">
      <section class="member-auth-card" aria-labelledby="signin-title">
        <div class="member-auth-card-heading">
          <img class="member-auth-logo" src="/assets/logo.svg" alt="" width="112" height="112">
          <h1 id="signin-title">Sign in to My STC</h1>
          <p data-member-signin-intro data-default-message="${escapeHtml(actionMessage)}">${escapeHtml(actionMessage)}</p>
        </div>
        <form class="contact-form member-auth-form" data-member-signin-form autocomplete="on">
          <input type="hidden" name="return_path" value="${escapeHtml(returnPath)}">
          <input type="hidden" name="intent_type" value="${escapeHtml(intentType)}">
          <input type="hidden" name="target_id" value="${escapeHtml(targetId)}">
          ${formGroup("Email address", '<input class="form-control" name="email" type="email" maxlength="254" required autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com">', "Use an address you can access. The link expires after 15 minutes and works once.")}
          ${turnstile(env, "member_signin")}
          <button type="submit" class="btn member-primary-button">Email me a sign-in link <i class="fas fa-arrow-right" aria-hidden="true"></i></button>
          <button type="button" class="btn member-secondary-button member-auth-reset" data-member-signin-reset hidden>Use another email</button>
          ${notice()}
          <div class="member-development-link" data-development-signin hidden></div>
        </form>
        <p class="member-fine-print member-auth-privacy"><i class="fas fa-lock" aria-hidden="true"></i><span>By continuing, you agree that Serve the Cays may use this email to provide your account and requested transactional messages. See our <a href="/privacy">Privacy Policy</a>.</span></p>
      </section>
    </div>
  </div>`;
  return layout({ env, path: "/signin", title: "Member Sign In - Serve the Cays", description: "Sign in to your Serve the Cays member account with a secure email link.", body, noindex: true, turnstile: true, referrerPolicy: "no-referrer" });
}

export function signInVerifyPage(env: Env): Response {
  const body = `<div class="container member-auth-shell">
    <div class="member-auth-layout member-verify-layout">
      <section class="member-auth-card" aria-labelledby="verify-title" data-member-verify>
        <div class="member-auth-card-heading">
          <img class="member-auth-logo" src="/assets/logo.svg" alt="" width="96" height="96">
          <span class="member-eyebrow">Secure email sign-in</span>
          <h1 id="verify-title">Confirm this sign-in</h1>
          <p>For your protection, opening this page does not use the link. Select Continue to finish signing in.</p>
        </div>
        <button class="btn member-primary-button" type="button" data-member-verify-continue disabled>Continue to My STC <i class="fas fa-arrow-right" aria-hidden="true"></i></button>
        <div class="form-status" role="status" aria-live="polite" data-member-verify-status hidden></div>
        <p class="member-fine-print member-auth-back"><a href="/signin"><i class="fas fa-arrow-left" aria-hidden="true"></i> Request a new sign-in link</a></p>
      </section>
    </div>
  </div>`;
  return layout({ env, path: "/signin/verify", title: "Confirm Sign In - Serve the Cays", description: "Confirm a secure Serve the Cays member sign-in.", body, noindex: true, referrerPolicy: "no-referrer" });
}

export function signOutPage(env: Env): Response {
  const body = `<div class="container member-auth-shell">
    <div class="member-auth-layout member-verify-layout">
      <section class="member-auth-card" aria-labelledby="signout-title" data-stc-signout>
        <div class="member-auth-card-heading">
          <img class="member-auth-logo" src="/assets/logo.svg" alt="" width="96" height="96">
          <span class="member-eyebrow">Account session</span>
          <h1 id="signout-title">Sign out of Serve the Cays</h1>
          <p>This clears your My STC and STC admin sessions in this browser. Cloudflare Access remains separate and protected.</p>
        </div>
        <button class="btn member-primary-button" type="button" data-stc-signout-confirm>Sign out</button>
        <div class="form-status" role="status" aria-live="polite" data-stc-signout-status hidden></div>
        <p class="member-fine-print member-auth-back"><a href="/"><i class="fas fa-arrow-left" aria-hidden="true"></i> Cancel and return home</a></p>
      </section>
    </div>
  </div>`;
  return layout({ env, path: "/signout", title: "Sign Out - Serve the Cays", description: "Clear Serve the Cays account sessions from this browser.", body, noindex: true, referrerPolicy: "no-referrer" });
}

export function memberDashboardPage(env: Env): Response {
  const body = `<div class="container member-dashboard" data-member-dashboard aria-busy="true">
    <section class="member-session-loading" data-member-session-loading role="status" aria-live="polite">
      <span class="member-loading-spinner" data-member-session-spinner aria-hidden="true"></span>
      <h1>Checking your session…</h1>
      <p>We’re securely confirming your My STC account.</p>
      <button class="btn member-secondary-button" type="button" data-member-session-retry hidden>Try again</button>
    </section>
    <div data-member-protected hidden inert>
    <header class="member-dashboard-header">
      <div><span class="member-eyebrow">Member account</span><h1>Welcome to My STC</h1><p data-member-welcome>Loading your member dashboard…</p></div>
      <div class="member-dashboard-actions"><button class="btn member-signout-button" type="button" data-member-logout><i class="fas fa-arrow-right-from-bracket" aria-hidden="true"></i> Sign out</button></div>
    </header>
        <div class="form-status" role="status" aria-live="polite" data-member-dashboard-status hidden></div>
        <section class="member-legacy-import" data-legacy-import hidden>
          <span class="member-panel-icon" aria-hidden="true"><i class="fas fa-cloud-arrow-up"></i></span>
          <div><h2>Bring over saved organizations</h2><p>We found favorites saved by the earlier browser-only version of STC. Import the matches to your account so they work across devices.</p></div>
          <button class="btn member-secondary-button" type="button" data-legacy-import-button>Review and import</button>
        </section>
        <div class="member-dashboard-grid">
          <section class="member-panel member-profile-panel" id="profile">
            <div class="member-panel-heading">
              <span class="member-panel-icon" aria-hidden="true"><i class="fas fa-user-gear"></i></span>
              <div><span class="member-panel-kicker">Account settings</span><h2>Profile &amp; notifications</h2><p>Choose how STC greets you and which useful updates reach your inbox.</p></div>
            </div>
            <form data-member-profile-form>
              <div class="member-profile-fields">
                ${formGroup("Email address", '<input class="form-control" name="email" type="email" readonly>')}
                ${formGroup("Display name", '<input class="form-control" name="display_name" maxlength="100" autocomplete="name" placeholder="How should we greet you?">')}
              </div>
              <div class="member-preference-list">
                <label class="member-check"><input type="checkbox" name="event_reminders_enabled"> <span><strong>Event reminders</strong><small>Email me about 24 hours before events I’m attending.</small></span></label>
                <div class="member-newsletter-preferences" data-member-newsletter-preferences>
                  <label class="member-check"><input type="checkbox" name="personalized_updates_enabled" disabled> <span><strong>Personalized community updates</strong><small>Use saved organizations plus the interests and places I choose below.</small></span></label>
                  <p class="member-fine-print" data-member-newsletter-status>Checking your community-update subscription…</p>
                  <p class="member-fine-print">Newsletter consent stays separate: account deletion does not unsubscribe community updates. Subscribe on the <a href="/#newsletter">home page</a> or unsubscribe from any community-update email.</p>
                </div>
              </div>
              <section class="member-notification-filters" aria-labelledby="member-event-filter-title">
                <div class="member-notification-filter-heading">
                  <span class="member-panel-kicker">Event update filters</span>
                  <h3 id="member-event-filter-title">Choose your interests and places</h3>
                  <p>Select the kinds of work and Bahamian communities you care about. Choose nothing in a group to receive matches from all interests or all places.</p>
                </div>
                <div class="member-notification-filter-grid">
                  <fieldset><legend>Interests</legend><div class="member-notification-options" data-member-notification-categories><p>Loading interests…</p></div></fieldset>
                  <fieldset><legend>Cities and islands</legend><div class="member-notification-options" data-member-notification-locations><p>Loading places…</p></div></fieldset>
                </div>
                <p class="member-fine-print">These filters apply only when you have separately subscribed to community updates and turned on personalization. You can choose up to 20 in each group.</p>
              </section>
              <div class="member-form-actions"><button class="btn member-primary-button" type="submit" data-member-profile-submit disabled>Save changes</button><p class="member-inline-status" role="status" aria-live="polite" data-member-profile-status></p></div>
            </form>
          </section>
          <section class="member-panel" id="saved-organizations">
            <div class="member-panel-heading member-panel-heading-compact"><span class="member-panel-icon" aria-hidden="true"><i class="fas fa-building-circle-check"></i></span><div><span class="member-panel-kicker">Your directory</span><h2>Saved organizations</h2></div></div>
            <div class="member-dashboard-list" data-saved-organizations><p>Loading…</p></div>
          </section>
          <section class="member-panel" id="saved-events">
            <div class="member-panel-heading member-panel-heading-compact"><span class="member-panel-icon" aria-hidden="true"><i class="fas fa-bookmark"></i></span><div><span class="member-panel-kicker">Your shortlist</span><h2>Saved events</h2></div></div>
            <div class="member-dashboard-list" data-saved-events><p>Loading…</p></div>
          </section>
          <section class="member-panel" id="rsvps">
            <div class="member-panel-heading member-panel-heading-compact"><span class="member-panel-icon" aria-hidden="true"><i class="fas fa-calendar-check"></i></span><div><span class="member-panel-kicker">Coming up</span><h2>Upcoming RSVPs</h2></div></div>
            <div class="member-dashboard-list" data-upcoming-rsvps><p>Loading…</p></div>
          </section>
          <section class="member-panel">
            <div class="member-panel-heading member-panel-heading-compact"><span class="member-panel-icon" aria-hidden="true"><i class="fas fa-clock-rotate-left"></i></span><div><span class="member-panel-kicker">Your history</span><h2>Past RSVPs</h2></div></div>
            <div class="member-dashboard-list" data-past-rsvps><p>Loading…</p></div>
          </section>
          <section class="member-panel member-submissions-panel" id="suggestions">
            <div class="member-panel-heading member-panel-heading-compact member-panel-heading-with-action"><span class="member-panel-icon" aria-hidden="true"><i class="fas fa-lightbulb"></i></span><div><span class="member-panel-kicker">Community contributions</span><h2>My suggestions</h2><p>Track the organizations and events you’ve sent to the STC review team.</p></div><div class="member-panel-actions"><a class="btn member-primary-button member-panel-action" href="/suggest/event"><i class="fas fa-calendar-plus" aria-hidden="true"></i> Suggest an event</a><a class="btn member-secondary-button member-panel-action" href="/suggest/organization"><i class="fas fa-building-circle-arrow-right" aria-hidden="true"></i> Suggest an organization</a></div></div>
            <div class="member-dashboard-list" data-member-submissions><p>Loading…</p></div>
          </section>
          <section class="member-panel member-danger-zone" id="account">
            <div><span class="member-panel-kicker">Account controls</span><h2>Delete account</h2><p>Deleting your account signs you out everywhere and permanently removes your favorites and RSVPs. Existing suggestions remain in the moderation record but are disconnected from your account. Newsletter consent remains separate.</p></div>
            <button class="btn member-danger-button" type="button" data-member-delete-account>Delete my account</button>
          </section>
    </div>
    <dialog class="member-delete-dialog" data-member-delete-dialog aria-labelledby="member-delete-title" aria-describedby="member-delete-description">
      <div class="member-delete-dialog-icon" aria-hidden="true"><i class="fas fa-user-slash"></i></div>
      <h2 id="member-delete-title">Delete your STC account?</h2>
      <p id="member-delete-description">This permanently removes your saved organizations, saved events, and RSVP history, and signs you out everywhere. Suggestions already in moderation remain but are disconnected from your account. If you receive community updates, use an unsubscribe link in those emails to stop them.</p>
      <div class="member-dialog-actions"><button class="btn member-secondary-button" type="button" data-member-delete-cancel>Keep my account</button><button class="btn member-danger-button" type="button" data-member-delete-confirm>Permanently delete account</button></div>
    </dialog>
    <dialog class="member-delete-dialog member-logout-dialog" data-member-logout-dialog aria-labelledby="member-logout-title" aria-describedby="member-logout-description">
      <div class="member-delete-dialog-icon member-logout-dialog-icon" aria-hidden="true"><i class="fas fa-arrow-right-from-bracket"></i></div>
      <h2 id="member-logout-title">Sign out of My STC?</h2>
      <p id="member-logout-description">You’ll need a new one-time email link to access your saved organizations, events, and suggestions again.</p>
      <div class="member-dialog-actions"><button class="btn member-secondary-button" type="button" data-member-logout-cancel>Cancel</button><button class="btn member-primary-button" type="button" data-member-logout-confirm>Sign out</button></div>
    </dialog>
    </div>
  </div>`;
  return layout({ env, path: "/me", title: "My STC - Serve the Cays", description: "Manage your Serve the Cays member profile, saved items, and event RSVPs.", body, noindex: true, referrerPolicy: "no-referrer" });
}

export function aboutPage(env: Env): Response {
  const body = `<div class="container"><div class="about-content">
    <h2>About Serve the Cays</h2>
    <p>Serve the Cays is a community platform dedicated to connecting individuals with meaningful opportunities to help our local community. We believe that mentorship, guidance, and acts of service can create big changes in the lives of those around us.</p>
    <p>Our mission is to make it easy for people to find volunteer organizations, youth programs, and mentorship initiatives that align with their interests and skills, while helping these organizations reach more people who are passionate about their causes.</p>
    <p>Whether you're looking to give back, mentor the next generation, or seek volunteers for your program, Serve the Cays is here to bridge the gap and strengthen our community bonds.</p>
    <p>Serve the Cays is operated and maintained by <a href="https://caynetic.ltd" target="_blank" rel="noopener noreferrer">Caynetic Ltd.</a></p>
    <p>Please note that Serve the Cays is an independent directory and is not officially affiliated with the organizations listed on this site. We simply aim to provide a centralized resource to help you discover these valuable community initiatives.</p>
  </div></div>`;
  return layout({ env, path: "/about", title: "About - Serve the Cays", description: "Learn about our mission to connect the community with meaningful service, mentorship, and guidance opportunities across the Bahamas.", body });
}

export function developmentInboxPage(env: Env): Response {
  const body = `<div class="container member-dashboard member-development-dashboard" data-development-inbox>
    <header class="member-dashboard-header member-inbox-header">
      <div><span class="member-eyebrow">Message preview</span><h1>Development inbox</h1><p>Inspect transactional messages and community updates generated by the local application.</p></div>
      <div class="member-dashboard-actions"><button class="btn member-secondary-button" type="button" data-development-newsletter-process><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Build weekly digest</button><button class="btn member-primary-button" type="button" data-development-inbox-refresh><i class="fas fa-rotate" aria-hidden="true"></i> Refresh</button></div>
    </header>
    <div class="member-inbox-safety"><i class="fas fa-circle-info" aria-hidden="true"></i><p><strong>Safe preview environment.</strong> Nothing shown here is delivered to a real recipient.</p></div>
    <div class="form-status" role="status" aria-live="polite" data-development-inbox-status hidden></div>
    <section class="member-inbox-panel" aria-labelledby="development-inbox-title">
      <div class="member-inbox-panel-heading"><div><span class="member-panel-kicker">Captured locally</span><h2 id="development-inbox-title">Generated messages</h2></div></div>
      <div class="member-inbox-list" data-development-inbox-list><p>Loading local messages…</p></div>
    </section>
  </div>`;
  return layout({ env, path: "/dev/inbox", title: "Local Email Inbox - Serve the Cays", description: "Development-only transactional and newsletter email inbox.", body, noindex: true, referrerPolicy: "no-referrer" });
}

export function privacyPage(env: Env): Response {
  const body = `<div class="container">
    <h1>Privacy Policy</h1><p><em>Last updated: August 21, 2026</em></p>
    <h2>Who We Are</h2><p>Serve the Cays is operated by <a href="https://caynetic.ltd" target="_blank" rel="noopener noreferrer">Caynetic Ltd.</a> Caynetic Ltd. is the data controller responsible for the personal information described in this policy.</p>
    <h2>Information We Collect</h2>
    <p><strong>Member accounts:</strong> Your email address, optional display name, account and verification timestamps, reminder and event-update preferences, favorites, event RSVPs and cancellations, and the connection between your account and every organization or event suggestion you submit.</p>
    <p><strong>Sign-in and security:</strong> Single-use sign-in-link and session records, expiration and activity times, keyed hashes used for rate limiting, and essential session and request-protection values. We store hashes of sign-in and session tokens rather than the tokens themselves.</p>
    <p><strong>Organization and event suggestions:</strong> Listing details, locations and categories, connected organizations, your verified member email for private review, other private submitter contact details you provide, contact details specifically designated for publication, and an optional image and image description.</p>
    <p><strong>Newsletter signup:</strong> Before subscription, we keep your email address, an expiring confirmation request, a hash of the confirmation token, delivery status for the confirmation message, and a keyed hash of a network identifier. We record consent time and activate the address only after you confirm control of it. For active subscriptions, we keep subscription status, personalization choice, selected event interests and places, an account connection when you sign in with the same subscribed address, private unsubscribe and customization-token hashes, and delivery history.</p>
    <p><strong>Organization outreach:</strong> For private relationship management, administrators may record an organization name, contact name, business email address or phone number, follow-up dates, private notes, communication type and time, and a sent-message link, message ID, or provider reference. Each activity also records the administrator who added it. This outreach history is not published on the website.</p>
    <p><strong>Technical and security information:</strong> Cloudflare processes IP addresses, browser and request signals, and Turnstile security-check data when it delivers and protects the site. In its own application records, Serve the Cays stores keyed hashes of network identifiers for rate limiting and security auditing rather than storing raw IP addresses. Separate keyed submission fingerprints help prevent duplicate suggestions.</p>
    <h2>How We Use Information</h2><p>We use information to create and secure member accounts; synchronize saved organizations and events; record RSVPs and display only aggregate attendance counts; send requested sign-in, welcome, RSVP, cancellation, reminder, submission, and moderation messages; review and verify suggestions; manage organization outreach and follow-up history; manage newsletter choices; prevent abuse; protect the service; respond to requests; and comply with applicable law. We do not use personal information for third-party advertising.</p>
    <h2>Event RSVPs</h2><p>Event pages may show a total number of people going. We do not publish attendee names, email addresses, or individual RSVP histories. Linked organizations do not receive member identity information through the public directory.</p>
    <h2>Private Review and Public Information</h2><p>Private submitter email addresses and phone numbers are not copied into public listings. Listing details, contact fields clearly designated as public, and a sanitized, metadata-free image derivative are published only after the complete submission is approved. Public information can be indexed or copied by search engines and other third parties. Only submit information or images that you are authorized to share, especially when another person or a child appears in the content.</p>
    <h2>Service Providers, Email, Cookies, and International Processing</h2><p>We use Cloudflare for application hosting, database and object storage, image processing, content delivery, bot protection, and delivery of requested sign-in and account messages plus RSVP and suggestion notifications. For those requested messages, Cloudflare receives the recipient address and message content needed for delivery and may return message identifiers or delivery status. We use <a href="https://forwardemail.net" target="_blank" rel="noopener noreferrer">Forward Email</a> separately for newsletter confirmations and general or personalized community updates. Forward Email receives the recipient address and newsletter content needed for delivery and may return message identifiers, delivery status, bounces, or complaints. We authenticate Forward Email event notices before recording them, keep only bounded delivery evidence rather than the raw provider payload, suppress newsletter addresses after complaints and documented hard-bounce categories, and do not blindly resend a message when provider acceptance is uncertain. Turnstile evaluates browser and request signals and our server sends the verification token and IP address to Cloudflare for validation; see Cloudflare's <a href="https://www.cloudflare.com/turnstile-privacy-policy/" target="_blank" rel="noopener noreferrer">Turnstile Privacy Addendum</a>. These providers operate globally, so personal information described above may be processed outside The Bahamas under their terms and privacy notices.</p>
    <p>Serve the Cays does not use advertising cookies or separate audience-tracking analytics. Cloudflare may use essential security cookies or similar signals. Member and administrator areas use separate essential session cookies. A member session expires after seven days of inactivity and no later than 30 days after it begins.</p>
    <h2>Retention</h2><p>Expired email sign-in-link records are removed after 24 hours. Newsletter confirmation links expire after 24 hours, and expired or completed confirmation-request metadata is removed under the 90-day email-metadata schedule. Expired sessions cease to work automatically. Transactional and newsletter delivery metadata, including bounded authenticated bounce or complaint evidence, is kept for 90 days. Favorites and RSVP history remain until the member deletes the account or asks us to remove them. The connection between an account and its suggestions remains while the account exists so the member can track review status. Deleting an account revokes its sessions, deletes its favorites and RSVPs, and disconnects retained suggestions from the account.</p>
    <p>By default, approved and denied original images are scheduled for removal after 30 days. Pending or quarantined original images, private submitter contact details, proposed public email and phone values, staged repeatable organization contacts, and staged profile sections are removed or anonymized after 90 days. Approved public listings, sanitized image derivatives, and moderation or security evidence may remain while needed to operate the directory, preserve the integrity of decisions, resolve disputes, or meet legal obligations.</p>
    <p>Newsletter consent is separate from a member account and from essential transactional messages. Requesting a confirmation email, signing in, or creating an account does not subscribe or reactivate an address. Deleting a member account disconnects the newsletter record and returns future updates to the general version, but does not unsubscribe it. Newsletter information remains active while you are subscribed. Unsubscribing stops future newsletter messages without preventing requested sign-in links or RSVP notices. We retain the email address, original confirmation-based consent time, opt-out status, and related security hashes as a suppression record so the address is not accidentally reactivated.</p>
    <p>Organization outreach contacts and append-only communication evidence remain while needed to manage the relationship, document what was actually sent or received, avoid duplicate contact, preserve the integrity of the record, or meet legal obligations. Administrators can correct the current contact record without rewriting past activities.</p>
    <h2>Information Sharing</h2><p>We do not sell or rent personal information. We disclose information only when you designate it for publication and the listing is approved, to the service providers described above as needed to operate and protect the site, or when disclosure is required by law or reasonably necessary to protect rights, safety, or the service.</p>
    <h2>Your Choices and Rights</h2><p>Members can update their display name, reminder preference, event-interest and place filters, and personalized-newsletter choice or delete their account from My STC. Subject to applicable law and appropriate identity verification, you may also ask whether we hold personal information about you, request access to it, correct inaccurate information, request deletion when there is no valid reason to retain it, or object to direct marketing. You can unsubscribe from newsletter messages using the link included in them; deleting only your member account does not unsubscribe newsletters. If a privacy concern remains unresolved after contacting us, you may contact the <a href="https://www.bahamas.gov.bs/dataprotection" target="_blank" rel="noopener noreferrer">Office of the Data Protection Commissioner of The Bahamas</a>.</p>
    <h2>Security</h2><p>We use access controls, separate private and public storage, keyed hashing, constrained uploads, and sanitized image derivatives to protect information. No internet transmission or storage system can be guaranteed completely secure.</p>
    <h2>Changes to This Policy</h2><p>We may update this policy when the service or its privacy practices change. The date at the top shows the latest revision.</p>
    <h2>Contact Us</h2><p>To ask about a submission, newsletter record, public listing, your personal information, or this Privacy Policy, email <a href="mailto:hello@servethecays.com">hello@servethecays.com</a>.</p>
  </div>`;
  return layout({ env, path: "/privacy", title: "Privacy Policy - Serve the Cays", description: "Privacy policy for Serve the Cays website and services.", body });
}

export function unsubscribePage(env: Env, token: string): Response {
  const body = `<div class="container member-auth-shell">
    <section class="member-auth-card member-action-card" aria-labelledby="unsubscribe-title">
      <div class="member-auth-card-heading"><span class="member-auth-card-icon" aria-hidden="true"><i class="fas fa-envelope-circle-xmark"></i></span><span class="member-eyebrow">Community updates</span><h1 id="unsubscribe-title">Unsubscribe</h1><p>Stop future Serve the Cays community updates?</p></div>
      <div class="member-action-summary"><i class="fas fa-circle-info" aria-hidden="true"></i><p>This will unsubscribe the address associated with this private link. Requested sign-in and account messages remain available.</p></div>
      <button class="btn member-danger-button" type="button" data-unsubscribe-token="${escapeHtml(token)}">Confirm unsubscribe</button>
      <div class="form-status" role="status" aria-live="polite" hidden></div>
      ${notice()}
      <p class="member-fine-print member-auth-back"><a href="/"><i class="fas fa-arrow-left" aria-hidden="true"></i> Return to home</a></p>
    </section>
  </div>`;
  return layout({ env, path: `/unsubscribe/${encodeURIComponent(token)}`, title: "Unsubscribe - Serve the Cays", description: "Manage your Serve the Cays newsletter subscription.", body, noindex: true, referrerPolicy: "no-referrer" });
}

export function newsletterConfirmationPage(env: Env): Response {
  const body = `<div class="container member-auth-shell" data-newsletter-confirm>
    <section class="member-auth-card member-action-card" aria-labelledby="newsletter-confirm-title">
      <div class="member-auth-card-heading"><span class="member-auth-card-icon" aria-hidden="true"><i class="fas fa-envelope-open-text"></i></span><span class="member-eyebrow">Community updates</span><h1 id="newsletter-confirm-title">Confirm your subscription</h1><p>One final step keeps Serve the Cays updates permission-based.</p></div>
      <div class="member-action-summary"><i class="fas fa-shield-heart" aria-hidden="true"></i><p>Choose Confirm below to verify this email address. You will not receive community updates until confirmation succeeds.</p></div>
      <button class="btn member-primary-button" type="button" data-newsletter-confirm-continue disabled>Confirm community updates</button>
      <div class="form-status" role="status" aria-live="polite" data-newsletter-confirm-status>Preparing your private confirmation link…</div>
      <p class="member-fine-print member-auth-back"><a href="/"><i class="fas fa-arrow-left" aria-hidden="true"></i> Return to home</a></p>
    </section>
  </div>`;
  return layout({
    env,
    path: "/newsletter/confirm",
    title: "Confirm Community Updates - Serve the Cays",
    description: "Confirm your Serve the Cays community update subscription.",
    body,
    noindex: true,
    referrerPolicy: "no-referrer",
  });
}

export function adminPage(env: Env): Response {
  const body = `<section class="admin-shell">
    <div class="container admin-container">
      <div class="admin-app" data-admin-app>
        <header class="admin-header">
          <div><span class="eyebrow">Private administration</span><h1>Manage Serve the Cays</h1><p data-admin-identity></p></div>
          <div class="admin-header-actions"><a class="button secondary compact" href="/api/admin/subscribers.csv">Export subscribers</a><button class="button admin-signout compact" type="button" data-admin-logout>Sign out</button></div>
        </header>
        ${notice()}
        <div class="summary-grid" data-admin-summary></div>
        <div class="admin-view-tabs" role="tablist" aria-label="Administration sections">
          <button class="admin-view-tab active" id="admin-tab-moderation" role="tab" type="button" data-admin-view-button="moderation" aria-controls="review-queue" aria-selected="true">Moderation</button>
          <button class="admin-view-tab" id="admin-tab-outreach" role="tab" type="button" data-admin-view-button="outreach" aria-controls="outreach-workspace" aria-selected="false">Outreach ledger</button>
          <button class="admin-view-tab" id="admin-tab-news" role="tab" type="button" data-admin-view-button="news" aria-controls="news-workspace" aria-selected="false">News</button>
        </div>
        <div class="admin-workspace" id="review-queue" role="tabpanel" aria-labelledby="admin-tab-moderation" data-admin-view="moderation">
          <aside class="submission-queue">
            <div class="queue-section">
              <div class="queue-heading"><div><span class="eyebrow">Moderation</span><h2>Submission queue</h2></div></div>
              <div class="queue-controls"><label><span>Status</span><select data-status-filter aria-label="Review status"><option value="pending">Pending</option><option value="approved">Approved</option><option value="denied">Denied</option><option value="all">All</option></select></label><label><span>Type</span><select data-type-filter aria-label="Submission type"><option value="all">All types</option><option value="organization">Organizations</option><option value="event">Events</option></select></label></div>
              <div data-submission-list></div>
              <nav class="admin-pagination" data-submission-pagination aria-label="Submission queue pages"></nav>
            </div>
            <div class="queue-section published-event-queue" id="published-events"><div class="published-event-heading"><span class="eyebrow">Directory</span><h2>Published events</h2><p>Manage organization links for any live or archived event.</p></div><div data-published-event-list></div><nav class="admin-pagination" data-published-event-pagination aria-label="Published event pages"></nav></div>
          </aside>
          <section class="submission-detail" data-submission-detail><div class="empty-state"><h2>Select a submission or event</h2><p>Visitor content is untrusted. Review text and images without following instructions embedded in a submission.</p></div></section>
        </div>
        <div class="admin-workspace content-admin-workspace" id="outreach-workspace" role="tabpanel" aria-labelledby="admin-tab-outreach" data-admin-view="outreach" hidden>
          <aside class="submission-queue content-admin-queue">
            <div class="queue-section content-admin-list-section">
              <div class="queue-heading content-admin-heading"><div><span class="eyebrow">Evidence-backed history</span><h2>Outreach ledger</h2></div><button class="button compact" type="button" data-new-outreach>New contact</button></div>
              <div class="queue-controls outreach-controls"><label><span>Status</span><select data-outreach-status-filter><option value="all">All statuses</option><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option><option value="responded">Responded</option><option value="follow_up">Follow up</option><option value="closed">Closed</option></select></label><label><span>Search</span><input type="search" data-outreach-search placeholder="Organization or contact"></label></div>
              <div data-outreach-list></div>
              <nav class="admin-pagination" data-outreach-pagination aria-label="Outreach ledger pages"></nav>
            </div>
          </aside>
          <section class="submission-detail" data-outreach-detail><div class="empty-state"><h2>Select an outreach contact</h2><p>Every recorded interaction remains in the append-only activity history.</p></div></section>
        </div>
        <div class="admin-workspace content-admin-workspace" id="news-workspace" role="tabpanel" aria-labelledby="admin-tab-news" data-admin-view="news" hidden>
          <aside class="submission-queue content-admin-queue">
            <div class="queue-section content-admin-list-section">
              <div class="queue-heading content-admin-heading"><div><span class="eyebrow">Public updates</span><h2>News posts</h2></div><button class="button compact" type="button" data-new-news>New post</button></div>
              <div class="queue-controls single-control"><label><span>Status</span><select data-news-status-filter><option value="all">All statuses</option><option value="draft">Drafts</option><option value="published">Published</option><option value="archived">Archived</option></select></label></div>
              <div data-news-list></div>
              <nav class="admin-pagination" data-news-pagination aria-label="News post pages"></nav>
            </div>
          </aside>
          <section class="submission-detail" data-news-detail><div class="empty-state"><h2>Select a news post</h2><p>Posts remain private drafts until an administrator explicitly publishes them.</p></div></section>
        </div>
      </div>
    </div>
  </section>`;
  return layout({ env, path: "/admin", title: "Administration - Serve the Cays", description: "Private Serve the Cays moderation dashboard.", body, noindex: true, admin: true });
}

export function notFoundPage(env: Env): Response {
  const response = layout({ env, path: "/404", title: "Cay Not Found - Serve the Cays", description: "We could not find the cay you were looking for.", body: '<section class="error-page"><div class="container"><div class="error-content"><h1>404</h1><h2>We couldn\'t find the cay you were looking for.</h2><p>It may have drifted out with the tide, or the address may be off by a sandbar.</p><p>Let\'s get you back to familiar waters.</p><a href="/" class="btn btn-primary">Head back to shore</a></div></div></section>', noindex: true });
  return new Response(response.body, { status: 404, headers: response.headers });
}

export function serverErrorPage(env: Env): Response {
  const response = layout({ env, path: "/500", title: "A Squall Rolled Through - Serve the Cays", description: "Serve the Cays encountered an unexpected error.", body: '<section class="error-page"><div class="container"><div class="error-content"><h1>500</h1><h2>A squall rolled through our servers.</h2><p>Something got a little choppy on our side. The crew has been notified.</p><p>Please give the water a moment to settle, then try again.</p><a href="/" class="btn btn-primary">Return to calm waters</a></div></div></section>', noindex: true });
  return new Response(response.body, { status: 500, headers: response.headers });
}
