import { logout, optionalAdminSession, session } from "./auth";
import {
  approve,
  deny,
  listPublishedEvents,
  listSubmissions,
  publishedEventOrganizationDetail,
  restore,
  submissionDetail,
  submissionImage,
  subscribersCsv,
  summary,
  updatePublishedEventOrganizations,
  updateSubmissionOrganizations,
} from "./admin";
import {
  addOutreachActivity,
  changeNewsStatus,
  createNews,
  createOutreach,
  listNewsAdmin,
  listOutreach,
  newsAdminDetail,
  outreachDetail,
  updateNews,
  updateOutreach,
} from "./content-admin";
import {
  eventApi,
  eventsApi,
  organizationApi,
  organizationsApi,
  robots,
  sitemap,
} from "./directory";
import { ApiError, apiErrorResponse, json, parseBoolean, redirect, securityHeaders } from "./http";
import { publishedImageResponse, purgeExpiredOriginals } from "./images";
import {
  consumeMemberMagicLink,
  logoutMember,
  logoutStcSessions,
  memberSession,
  purgeExpiredMemberAuth,
  requestMemberMagicLink,
} from "./member-auth";
import {
  deleteEventFavorite,
  deleteEventRsvp,
  deleteMemberAccount,
  deleteOrganizationFavorite,
  importLegacyFavorites,
  memberDashboard,
  setEventFavorite,
  setEventRsvp,
  setOrganizationFavorite,
  updateMemberProfile,
} from "./members";
import {
  developmentEmailInbox,
  memberMaintenance,
  processEmailJobs,
  transactionalEmailDeliveryEnabled,
} from "./email";
import { EMAIL_LOGO_PATH } from "./email-layout";
import {
  developmentNewsletterInbox,
  confirmNewsletterSubscription,
  fanoutNewsletterDigest,
  generateWeeklyDigest,
  ingestForwardEmailEvent,
  newsletterMaintenance,
  newsletterDeliveryEnabled,
  newsletterReconciliationEnabled,
  newsletterSubscriptionEnabled,
  oneClickUnsubscribe,
  processNewsletterConfirmationJobs,
  processNewsletterJobs,
  reconcileNewsletterDeliveries,
  subscribe,
  unsubscribe,
} from "./newsletter";
import {
  aboutPage,
  adminPage,
  developmentInboxPage,
  eventPage,
  eventsPage,
  homePage,
  memberDashboardPage,
  newsPage,
  newsPostPage,
  newsletterConfirmationPage,
  notFoundPage,
  organizationPage,
  organizationsPage,
  privacyPage,
  serverErrorPage,
  signInPage,
  signInVerifyPage,
  signOutPage,
  suggestEventPage,
  suggestOrganizationPage,
  unsubscribePage,
} from "./pages";
import { anonymizeExpiredPrivateSubmissions } from "./retention";
import { expectedOrigin, purgeExpiredRateLimits, requireSameOrigin } from "./security";
import { submitEvent, submitOrganization, taxonomy } from "./submissions";
import type { Env } from "./types";

const TRANSACTIONAL_EMAIL_CRON = "*/15 * * * *";
const DAILY_MAINTENANCE_CRON = "17 6 * * *";
const SCHEDULED_EMAIL_BATCH_SIZE = 10;

interface ScheduledTaskResult<T> {
  task: string;
  value: T | null;
  failed: boolean;
}

export function memberApplicationEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test") return true;
  const previewReviewEnabled = env.ENVIRONMENT === "preview"
    && parseBoolean(env.PREVIEW_MEMBER_REVIEW_ENABLED, false);
  const deliveryReady = parseBoolean(env.TRANSACTIONAL_EMAIL_DELIVERY_ENABLED, false)
    && parseBoolean(env.EMAIL_DELIVERY_RECONCILIATION_VERIFIED, false);
  return parseBoolean(env.MEMBER_APPLICATION_ENABLED, false)
    && parseBoolean(env.MEMBER_SCHEMA_RELEASE_READY, false)
    && parseBoolean(env.ADMIN_STEP_UP_VERIFIED, false)
    && (previewReviewEnabled || deliveryReady);
}

function memberApplicationPath(path: string): boolean {
  return path === "/api/submissions/organizations"
    || path === "/api/submissions/events"
    || path.startsWith("/api/member/")
    || path === "/suggest/organization"
    || path === "/suggest/event"
    || path === "/signin"
    || path === "/signin/verify"
    || path === "/me";
}

async function scheduledTask<T>(task: string, operation: () => Promise<T>): Promise<ScheduledTaskResult<T>> {
  try {
    return { task, value: await operation(), failed: false };
  } catch (error) {
    console.error(JSON.stringify({
      event: "scheduled_task_failed",
      task,
      message: error instanceof Error ? error.message : "Unknown scheduled task failure",
    }));
    return { task, value: null, failed: true };
  }
}

function scheduledMetric(result: ScheduledTaskResult<unknown>): number {
  if (typeof result.value === "number") return result.value;
  return result.value == null ? 0 : 1;
}

async function runTransactionalEmailSchedule(env: Env): Promise<void> {
  const results = [await scheduledTask(
    "transactional_email_delivery",
    () => processEmailJobs(env, SCHEDULED_EMAIL_BATCH_SIZE),
  )];
  if (newsletterSubscriptionEnabled(env)) {
    results.push(await scheduledTask(
      "newsletter_confirmation_delivery",
      () => processNewsletterConfirmationJobs(env, SCHEDULED_EMAIL_BATCH_SIZE),
    ));
  }
  if (newsletterReconciliationEnabled(env)) {
    results.push(await scheduledTask(
      "newsletter_delivery_reconciliation",
      () => reconcileNewsletterDeliveries(env, SCHEDULED_EMAIL_BATCH_SIZE),
    ));
  }
  if (results.some((result) => result.failed || scheduledMetric(result))) {
    console.log(JSON.stringify({
      event: "scheduled_run_completed",
      cron: TRANSACTIONAL_EMAIL_CRON,
      tasks: results.map((result) => ({
        task: result.task,
        failed: result.failed,
        processed: scheduledMetric(result),
      })),
    }));
  }
}

async function runDailyMaintenance(env: Env): Promise<void> {
  const results: ScheduledTaskResult<unknown>[] = await Promise.all([
    scheduledTask("purge_expired_originals", () => purgeExpiredOriginals(env)),
    scheduledTask("anonymize_expired_submissions", () => anonymizeExpiredPrivateSubmissions(env)),
    scheduledTask("purge_expired_rate_limits", () => purgeExpiredRateLimits(env)),
  ]);

  if (memberApplicationEnabled(env)) {
    results.push(await scheduledTask("purge_expired_member_auth", () => purgeExpiredMemberAuth(env)));
    if (transactionalEmailDeliveryEnabled(env)) {
      results.push(await scheduledTask("member_maintenance", () => memberMaintenance(env)));
    }
  }

  if (newsletterDeliveryEnabled(env)) {
    const digest = await scheduledTask("newsletter_digest", () => generateWeeklyDigest(env));
    results.push(digest);
    if (digest.value) {
      results.push(await scheduledTask(
        "newsletter_fanout",
        () => fanoutNewsletterDigest(env, digest.value as string, 250),
      ));
    }
    results.push(await scheduledTask("newsletter_delivery", () => processNewsletterJobs(env)));
    results.push(await scheduledTask("newsletter_maintenance", () => newsletterMaintenance(env)));
  }

  console.log(JSON.stringify({
    event: "scheduled_run_completed",
    cron: DAILY_MAINTENANCE_CRON,
    tasks: results.map((result) => ({
      task: result.task,
      failed: result.failed,
      processed: scheduledMetric(result),
    })),
  }));
}

function methodNotAllowed(allowed: string[]): Response {
  return json(
    { status: "error", code: "method_not_allowed", message: "This method is not allowed." },
    405,
    { Allow: allowed.join(", ") },
  );
}

function canonicalRedirectLocation(url: URL, env: Env): string {
  const destination = new URL(expectedOrigin(env));
  let pathname = `/${url.pathname.replace(/^\/+/, "")}`;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  destination.pathname = pathname;
  destination.search = url.search;
  return destination.toString();
}

function secureStaticAsset(response: Response, path: string): Response {
  const headers = new Headers(response.headers);
  if (response.ok && path === EMAIL_LOGO_PATH) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  const baseline = securityHeaders();
  baseline.delete("Content-Type");
  baseline.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (env.ENVIRONMENT === "production" && url.origin !== expectedOrigin(env)) {
    if (method === "GET" || method === "HEAD") {
      return redirect(canonicalRedirectLocation(url, env), 308);
    }
    throw new ApiError(403, "origin_denied", "This request must use the canonical Serve the Cays domain.");
  }

  if (
    (path.startsWith("//") || (path.length > 1 && path.endsWith("/"))) &&
    (method === "GET" || method === "HEAD")
  ) {
    return redirect(canonicalRedirectLocation(url, env), 308);
  }

  if (path.startsWith("/assets/") || path.startsWith("/static/")) {
    return secureStaticAsset(await env.ASSETS.fetch(request), path);
  }

  if (!memberApplicationEnabled(env) && memberApplicationPath(path)) {
    throw new ApiError(404, "not_found", "Not found.");
  }

  if (path === "/api/admin/login") throw new ApiError(404, "not_found", "Not found.");
  if (path === "/api/admin/session") return method === "GET" ? session(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/admin/logout") return method === "POST" ? logout(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/admin/summary") return method === "GET" ? summary(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/admin/submissions") return method === "GET" ? listSubmissions(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/admin/events") return method === "GET" ? listPublishedEvents(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/admin/subscribers.csv") return method === "GET" ? subscribersCsv(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/admin/outreach") {
    if (method === "GET") return listOutreach(request, env);
    if (method === "POST") return createOutreach(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }
  if (path === "/api/admin/news") {
    if (method === "GET") return listNewsAdmin(request, env);
    if (method === "POST") return createNews(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }

  const outreachActivity = path.match(/^\/api\/admin\/outreach\/([^/]+)\/activities$/);
  if (outreachActivity) {
    return method === "POST"
      ? addOutreachActivity(request, env, decodeURIComponent(outreachActivity[1]))
      : methodNotAllowed(["POST"]);
  }
  const outreachContact = path.match(/^\/api\/admin\/outreach\/([^/]+)$/);
  if (outreachContact) {
    const id = decodeURIComponent(outreachContact[1]);
    if (method === "GET") return outreachDetail(request, env, id);
    if (method === "PUT") return updateOutreach(request, env, id);
    return methodNotAllowed(["GET", "PUT"]);
  }
  const newsStatusAction = path.match(/^\/api\/admin\/news\/([^/]+)\/(publish|unpublish|archive)$/);
  if (newsStatusAction) {
    return method === "POST"
      ? changeNewsStatus(
        request,
        env,
        decodeURIComponent(newsStatusAction[1]),
        newsStatusAction[2] as "publish" | "unpublish" | "archive",
      )
      : methodNotAllowed(["POST"]);
  }
  const newsPostAdmin = path.match(/^\/api\/admin\/news\/([^/]+)$/);
  if (newsPostAdmin) {
    const id = decodeURIComponent(newsPostAdmin[1]);
    if (method === "GET") return newsAdminDetail(request, env, id);
    if (method === "PUT") return updateNews(request, env, id);
    return methodNotAllowed(["GET", "PUT"]);
  }

  const adminSubmissionOrganizations = path.match(/^\/api\/admin\/submissions\/event\/([^/]+)\/organizations$/);
  if (adminSubmissionOrganizations) {
    return method === "PUT"
      ? updateSubmissionOrganizations(request, env, decodeURIComponent(adminSubmissionOrganizations[1]))
      : methodNotAllowed(["PUT"]);
  }
  const adminEventOrganizations = path.match(/^\/api\/admin\/events\/(\d+)\/organizations$/);
  if (adminEventOrganizations) {
    const eventId = Number(adminEventOrganizations[1]);
    if (method === "GET") return publishedEventOrganizationDetail(request, env, eventId);
    if (method === "PUT") return updatePublishedEventOrganizations(request, env, eventId);
    return methodNotAllowed(["GET", "PUT"]);
  }

  const adminSubmission = path.match(/^\/api\/admin\/submissions\/(organization|event)\/([^/]+)$/);
  if (adminSubmission) {
    return method === "GET"
      ? submissionDetail(request, env, adminSubmission[1], decodeURIComponent(adminSubmission[2]))
      : methodNotAllowed(["GET"]);
  }
  const adminImage = path.match(/^\/api\/admin\/submissions\/(organization|event)\/([^/]+)\/image$/);
  if (adminImage) {
    return method === "GET"
      ? submissionImage(request, env, adminImage[1], decodeURIComponent(adminImage[2]))
      : methodNotAllowed(["GET"]);
  }
  const adminAction = path.match(/^\/api\/admin\/submissions\/(organization|event)\/([^/]+)\/(approve|deny|restore)$/);
  if (adminAction) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const [, type, encodedId, action] = adminAction;
    const id = decodeURIComponent(encodedId);
    if (action === "approve") return approve(request, env, type, id);
    if (action === "deny") return deny(request, env, type, id);
    return restore(request, env, type, id);
  }

  if (path === "/api/submissions/organizations") return method === "POST" ? submitOrganization(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/submissions/events") return method === "POST" ? submitEvent(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/taxonomy") return method === "GET" ? taxonomy(env) : methodNotAllowed(["GET"]);
  if (path === "/api/newsletter/subscribe") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const response = await subscribe(request, env);
    ctx?.waitUntil(processNewsletterConfirmationJobs(env, 1));
    return response;
  }
  if (path === "/api/newsletter/confirm") return method === "POST" ? confirmNewsletterSubscription(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/newsletter/unsubscribe") return method === "POST" ? unsubscribe(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/email/forward-email/events") {
    return method === "POST" ? ingestForwardEmailEvent(request, env) : methodNotAllowed(["POST"]);
  }
  if (path === "/api/organizations") return method === "GET" ? organizationsApi(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/events") return method === "GET" ? eventsApi(request, env) : methodNotAllowed(["GET"]);
  const organizationApiMatch = path.match(/^\/api\/organizations\/([^/]+)$/);
  if (organizationApiMatch) return method === "GET" ? organizationApi(env, decodeURIComponent(organizationApiMatch[1])) : methodNotAllowed(["GET"]);
  const eventApiMatch = path.match(/^\/api\/events\/(\d+)$/);
  if (eventApiMatch) return method === "GET" ? eventApi(env, Number(eventApiMatch[1])) : methodNotAllowed(["GET"]);

  if (path === "/api/member/auth/request") return method === "POST" ? requestMemberMagicLink(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/member/auth/consume") return method === "POST" ? consumeMemberMagicLink(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/member/session") return method === "GET" ? memberSession(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/member/logout") return method === "POST" ? logoutMember(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/session/logout") return method === "POST" ? logoutStcSessions(request, env) : methodNotAllowed(["POST"]);
  if (path === "/api/member/dashboard") return method === "GET" ? memberDashboard(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/member/profile") return method === "PATCH" ? updateMemberProfile(request, env) : methodNotAllowed(["PATCH"]);
  if (path === "/api/member/account") return method === "DELETE" ? deleteMemberAccount(request, env) : methodNotAllowed(["DELETE"]);
  if (path === "/api/member/favorites/import") return method === "POST" ? importLegacyFavorites(request, env) : methodNotAllowed(["POST"]);
  const memberOrganizationFavorite = path.match(/^\/api\/member\/favorites\/organizations\/([^/]+)$/);
  if (memberOrganizationFavorite) {
    const id = decodeURIComponent(memberOrganizationFavorite[1]);
    if (method === "PUT") return setOrganizationFavorite(request, env, id);
    if (method === "DELETE") return deleteOrganizationFavorite(request, env, id);
    return methodNotAllowed(["PUT", "DELETE"]);
  }
  const memberEventFavorite = path.match(/^\/api\/member\/favorites\/events\/(\d+)$/);
  if (memberEventFavorite) {
    const id = Number(memberEventFavorite[1]);
    if (method === "PUT") return setEventFavorite(request, env, id);
    if (method === "DELETE") return deleteEventFavorite(request, env, id);
    return methodNotAllowed(["PUT", "DELETE"]);
  }
  const memberEventRsvp = path.match(/^\/api\/member\/events\/(\d+)\/rsvp$/);
  if (memberEventRsvp) {
    const id = Number(memberEventRsvp[1]);
    if (method === "PUT") return setEventRsvp(request, env, id);
    if (method === "DELETE") return deleteEventRsvp(request, env, id);
    return methodNotAllowed(["PUT", "DELETE"]);
  }
  if (path === "/api/dev/emails") return method === "GET" ? developmentEmailInbox(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/dev/newsletters") return method === "GET" ? developmentNewsletterInbox(request, env) : methodNotAllowed(["GET"]);
  if (path === "/api/dev/newsletters/process") {
    if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") {
      throw new ApiError(404, "not_found", "Not found.");
    }
    if (method !== "POST") return methodNotAllowed(["POST"]);
    requireSameOrigin(request, env);
    const confirmations = await processNewsletterConfirmationJobs(env, 100);
    const digestId = await generateWeeklyDigest(env);
    const queued = await fanoutNewsletterDigest(env, digestId, 250);
    const processed = await processNewsletterJobs(env, 100);
    return json({ status: "success", confirmations, digest_id: digestId, queued, processed });
  }

  const mediaMatch = path.match(/^\/media\/([^/]+)$/);
  if (mediaMatch) return method === "GET" ? publishedImageResponse(env, decodeURIComponent(mediaMatch[1])) : methodNotAllowed(["GET"]);

  if (path === "/robots.txt") return method === "GET" ? robots(env) : methodNotAllowed(["GET"]);
  if (path === "/sitemap.xml") return method === "GET" ? sitemap(env) : methodNotAllowed(["GET"]);
  const unsubscribeMatch = path.match(/^\/unsubscribe\/([A-Za-z0-9_-]{20,200})$/);
  if (unsubscribeMatch && method === "POST") {
    return oneClickUnsubscribe(request, env, unsubscribeMatch[1]);
  }
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);

  if (path === "/") return homePage(env);
  if (path === "/organizations") return organizationsPage(request, env);
  if (path === "/events") return eventsPage(request, env);
  if (path === "/news") return newsPage(env);
  const newsPostMatch = path.match(/^\/news\/([^/]+)$/);
  if (newsPostMatch) return newsPostPage(env, decodeURIComponent(newsPostMatch[1]));
  if (path === "/suggest/organization") return suggestOrganizationPage(request, env);
  if (path === "/suggest/event") return suggestEventPage(request, env);
  if (path === "/about") return aboutPage(env);
  if (path === "/privacy") return privacyPage(env);
  if (path === "/newsletter/confirm") return newsletterConfirmationPage(env);
  if (path === "/signin") return signInPage(request, env);
  if (path === "/signin/verify") return signInVerifyPage(env);
  if (path === "/signout") return signOutPage(env);
  if (path === "/me") return memberDashboardPage(env);
  if (path === "/dev/inbox" && (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test")) return developmentInboxPage(env);
  if (path === "/admin") {
    return await optionalAdminSession(request, env) ? adminPage(env) : notFoundPage(env);
  }
  const organizationPageMatch = path.match(/^\/organization\/([^/]+)$/);
  if (organizationPageMatch) return organizationPage(env, decodeURIComponent(organizationPageMatch[1]));
  const eventPageMatch = path.match(/^\/event\/(\d+)$/);
  if (eventPageMatch) return eventPage(env, Number(eventPageMatch[1]));
  if (unsubscribeMatch) return unsubscribePage(env, unsubscribeMatch[1]);
  return notFoundPage(env);
}

async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    const response = await route(request, env, ctx);
    if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
    return response;
  } catch (error) {
    if (new URL(request.url).pathname.startsWith("/api/") || new URL(request.url).pathname.startsWith("/media/")) {
      return apiErrorResponse(error);
    }
    if (error instanceof ApiError && error.status === 404) return notFoundPage(env);
    console.error("Page request failed", error);
    return serverErrorPage(env);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === TRANSACTIONAL_EMAIL_CRON) {
      ctx.waitUntil(runTransactionalEmailSchedule(env));
      return;
    }
    if (controller.cron === DAILY_MAINTENANCE_CRON) {
      ctx.waitUntil(runDailyMaintenance(env));
      return;
    }
    console.warn(JSON.stringify({ event: "scheduled_cron_ignored", cron: controller.cron }));
  },
} satisfies ExportedHandler<Env>;
