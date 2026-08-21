export interface Env {
  DB: D1Database;
  PRIVATE_UPLOADS: R2Bucket;
  PUBLISHED_MEDIA: R2Bucket;
  ASSETS: Fetcher;
  IMAGES?: ImagesBinding;
  EMAIL?: SendEmail;
  ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  REQUIRE_TURNSTILE?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_ORGANIZATION_SECRET?: string;
  TURNSTILE_EVENT_SECRET?: string;
  TURNSTILE_NEWSLETTER_SECRET?: string;
  TURNSTILE_MEMBER_SECRET?: string;
  SESSION_SECRET?: string;
  MEMBER_SESSION_SECRET?: string;
  IP_HASH_KEY?: string;
  RATE_LIMIT_HASH_KEY?: string;
  UNSUBSCRIBE_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
  SESSION_IDLE_TTL_SECONDS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  SUBMISSION_IP_LIMIT?: string;
  SUBMISSION_MEMBER_LIMIT?: string;
  NEWSLETTER_IP_LIMIT?: string;
  NEWSLETTER_EMAIL_LIMIT?: string;
  NEWSLETTER_CONFIRMATION_TTL_SECONDS?: string;
  MEMBER_APPLICATION_ENABLED?: string;
  PREVIEW_MEMBER_REVIEW_ENABLED?: string;
  MEMBER_SCHEMA_RELEASE_READY?: string;
  ADMIN_STEP_UP_VERIFIED?: string;
  MEMBER_SESSION_TTL_SECONDS?: string;
  MEMBER_SESSION_IDLE_TTL_SECONDS?: string;
  MEMBER_MAGIC_LINK_TTL_SECONDS?: string;
  MEMBER_LOGIN_IP_LIMIT?: string;
  MEMBER_LOGIN_EMAIL_LIMIT?: string;
  EMAIL_METADATA_RETENTION_DAYS?: string;
  EMAIL_FROM_SIGNIN?: string;
  EMAIL_FROM_NOTIFICATIONS?: string;
  EMAIL_REPLY_TO?: string;
  TRANSACTIONAL_EMAIL_DELIVERY_ENABLED?: string;
  EMAIL_DELIVERY_RECONCILIATION_VERIFIED?: string;
  NEWSLETTER_DELIVERY_ENABLED?: string;
  NEWSLETTER_SUBSCRIPTION_ENABLED?: string;
  NEWSLETTER_SUPPRESSION_INGESTION_VERIFIED?: string;
  NEWSLETTER_DOUBLE_OPT_IN_VERIFIED?: string;
  NEWSLETTER_FROM_EMAIL?: string;
  NEWSLETTER_DAILY_LIMIT?: string;
  FORWARD_EMAIL_NEWSLETTER_PASSWORD?: string;
  FORWARD_EMAIL_API_TOKEN?: string;
  FORWARD_EMAIL_WEBHOOK_SECRET?: string;
  NEWSLETTER_CONFIRMATION_SECRET?: string;
  PRIVATE_RETENTION_DAYS?: string;
  PRIVATE_SUBMISSION_RETENTION_DAYS?: string;
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "editor";
  csrfHash: string;
  expiresAt: string;
}

export interface LocationRow {
  id: string;
  slug: string;
  city: string;
  island: string;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
}

export interface MediaAssetRow {
  id: string;
  owner_type: "organization_submission" | "event_submission";
  owner_id: string;
  kind: "organization_logo" | "event_image";
  status: "quarantined" | "published" | "denied" | "deleted";
  alt_text: string;
  original_key: string;
  original_content_type: "image/jpeg" | "image/png" | "image/webp";
  original_size_bytes: number;
  original_width: number;
  original_height: number;
  original_sha256: string;
  derivative_key: string | null;
  derivative_content_type: string | null;
  derivative_size_bytes: number | null;
  derivative_width: number | null;
  derivative_height: number | null;
  created_at: string;
  published_at: string | null;
  denied_at: string | null;
  original_deleted_at: string | null;
  deleted_at: string | null;
}

export interface OrganizationSubmissionRow {
  id: string;
  member_id: string | null;
  status: "pending" | "approved" | "denied";
  name: string;
  description: string;
  details: string;
  website: string;
  submitter_email: string;
  submitter_phone: string;
  public_email: string;
  public_phone: string;
  new_location: string;
  image_asset_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  published_organization_id: string | null;
  created_at: string;
  updated_at: string;
}

export type OrganizationContactType = "email" | "phone";

export interface OrganizationPublicContactRow {
  id: string;
  contact_type: OrganizationContactType;
  label: string;
  value: string;
  normalized_value: string;
  sort_order: number;
  is_primary: number;
}

export type OrganizationSectionKind =
  | "mission"
  | "programs_services"
  | "ways_to_help"
  | "eligibility"
  | "hours";

export interface OrganizationSectionRow {
  id: string;
  section_kind: OrganizationSectionKind;
  heading: string;
  body_text: string;
  sort_order: number;
}

export interface EventSubmissionRow {
  id: string;
  member_id: string | null;
  status: "pending" | "approved" | "denied";
  name: string;
  description: string;
  details: string;
  start_at: string;
  end_at: string | null;
  timezone: string;
  venue_name: string;
  location_id: string | null;
  new_location: string;
  website: string;
  submitter_email: string;
  submitter_phone: string;
  public_email: string;
  public_phone: string;
  image_asset_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  published_event_id: number | null;
  created_at: string;
  updated_at: string;
}
