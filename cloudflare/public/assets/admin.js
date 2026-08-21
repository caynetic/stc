const publicMenuButton = document.querySelector(".hamburger");
const publicMobileMenu = document.querySelector(".mobile-menu");

function closePublicMenu() {
  if (!publicMenuButton || !publicMobileMenu) return;
  publicMenuButton.classList.remove("open");
  publicMenuButton.setAttribute("aria-expanded", "false");
  publicMenuButton.setAttribute("aria-label", "Open navigation menu");
  publicMobileMenu.classList.remove("open");
}

if (publicMenuButton && publicMobileMenu) {
  publicMenuButton.addEventListener("click", () => {
    const open = publicMenuButton.classList.toggle("open");
    publicMenuButton.setAttribute("aria-expanded", String(open));
    publicMenuButton.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    publicMobileMenu.classList.toggle("open", open);
  });
  publicMobileMenu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closePublicMenu));
  document.addEventListener("click", (event) => {
    if (!publicMenuButton.contains(event.target) && !publicMobileMenu.contains(event.target)) closePublicMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || publicMenuButton.getAttribute("aria-expanded") !== "true") return;
    closePublicMenu();
    publicMenuButton.focus();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) closePublicMenu();
  });
}

const appPanel = document.querySelector("[data-admin-app]");
const identity = document.querySelector("[data-admin-identity]");
const summaryRoot = document.querySelector("[data-admin-summary]");
const listRoot = document.querySelector("[data-submission-list]");
const submissionPaginationRoot = document.querySelector("[data-submission-pagination]");
const publishedEventListRoot = document.querySelector("[data-published-event-list]");
const publishedEventPaginationRoot = document.querySelector("[data-published-event-pagination]");
const detailRoot = document.querySelector("[data-submission-detail]");
const statusFilter = document.querySelector("[data-status-filter]");
const typeFilter = document.querySelector("[data-type-filter]");
const viewButtons = [...document.querySelectorAll("[data-admin-view-button]")];
const viewPanels = [...document.querySelectorAll("[data-admin-view]")];
const outreachListRoot = document.querySelector("[data-outreach-list]");
const outreachPaginationRoot = document.querySelector("[data-outreach-pagination]");
const outreachDetailRoot = document.querySelector("[data-outreach-detail]");
const outreachStatusFilter = document.querySelector("[data-outreach-status-filter]");
const outreachSearch = document.querySelector("[data-outreach-search]");
const newOutreachButton = document.querySelector("[data-new-outreach]");
const newsListRoot = document.querySelector("[data-news-list]");
const newsPaginationRoot = document.querySelector("[data-news-pagination]");
const newsDetailRoot = document.querySelector("[data-news-detail]");
const newsStatusFilter = document.querySelector("[data-news-status-filter]");
const newNewsButton = document.querySelector("[data-new-news]");
const logoutButton = document.querySelector("[data-admin-logout]");
const authChannel = typeof globalThis.BroadcastChannel === "function"
  ? new globalThis.BroadcastChannel("serve-the-cays-admin-auth")
  : null;

let csrfToken = "";
let activeKey = "";
let sessionGeneration = 0;
let detailRequestGeneration = 0;
let authenticated = false;
let submissionPage = 1;
let publishedEventPage = 1;
let outreachPage = 1;
let newsPage = 1;
let outreachOrganizations = [];
let activeOutreachId = "";
let activeNewsId = "";

const STALE_SESSION = Symbol("stale-session");

function element(tag, className = "", content = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function showStatus(container, message, kind) {
  const box = container?.querySelector(".form-status");
  if (!box) return;
  box.setAttribute("role", kind === "error" ? "alert" : "status");
  box.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  box.textContent = message;
  box.className = `form-status ${kind}`;
  box.hidden = false;
}

async function payload(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function clearPrivateState() {
  activeKey = "";
  detailRequestGeneration += 1;
  delete detailRoot.dataset.relationshipsDirty;
  identity.textContent = "";
  summaryRoot.replaceChildren();
  listRoot.replaceChildren();
  submissionPaginationRoot?.replaceChildren();
  publishedEventListRoot?.replaceChildren();
  publishedEventPaginationRoot?.replaceChildren();
  outreachListRoot?.replaceChildren();
  outreachPaginationRoot?.replaceChildren();
  newsListRoot?.replaceChildren();
  newsPaginationRoot?.replaceChildren();
  detailRoot.replaceChildren(emptyDetail());
  outreachDetailRoot?.replaceChildren(contentEmpty("Select an outreach contact", "Every recorded interaction remains in the append-only activity history."));
  newsDetailRoot?.replaceChildren(contentEmpty("Select a news post", "Posts remain private drafts until an administrator explicitly publishes them."));
  statusFilter.value = "pending";
  typeFilter.value = "all";
  submissionPage = 1;
  publishedEventPage = 1;
  outreachPage = 1;
  newsPage = 1;
  activeOutreachId = "";
  activeNewsId = "";
  outreachOrganizations = [];
}

function broadcastAuthenticationLoss() {
  authChannel?.postMessage({ type: "authentication-lost" });
}

function leaveAdmin(notifyPeers = true) {
  const wasAuthenticated = authenticated;
  sessionGeneration += 1;
  authenticated = false;
  csrfToken = "";
  clearPrivateState();
  appPanel.hidden = true;
  if (notifyPeers && wasAuthenticated) broadcastAuthenticationLoss();
  window.location.replace("/admin");
}

function showApp(session, focusHeading = false) {
  const displayName = session?.user?.display_name || session?.user?.email;
  const role = session?.user?.role;
  if (!session?.csrf_token || !displayName || !role) {
    throw new Error("The admin session response was invalid.");
  }
  sessionGeneration += 1;
  authenticated = true;
  csrfToken = session.csrf_token;
  clearPrivateState();
  appPanel.hidden = false;
  identity.textContent = `${displayName} · ${role}`;
  window.scrollTo(0, 0);
  if (focusHeading) {
    const heading = appPanel.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

function isCurrentSession(generation) {
  return authenticated && generation === sessionGeneration;
}

async function authenticatedPayload(input, init) {
  const generation = sessionGeneration;
  if (!isCurrentSession(generation)) return STALE_SESSION;
  try {
    const data = await payload(await fetch(input, init));
    return isCurrentSession(generation) ? data : STALE_SESSION;
  } catch (error) {
    if (!isCurrentSession(generation)) return STALE_SESSION;
    throw error;
  }
}

async function restoreSession(notifyPeersOnFailure = false) {
  const generation = sessionGeneration;
  try {
    const session = await payload(await fetch("/api/admin/session", { headers: { Accept: "application/json" } }));
    if (generation !== sessionGeneration) return;
    showApp(session);
    await Promise.all([loadSummary(), loadList(), loadPublishedEvents(), loadOutreach(), loadNews()]);
  } catch (error) {
    if (generation !== sessionGeneration) return;
    if (notifyPeersOnFailure && error.status === 401) broadcastAuthenticationLoss();
    leaveAdmin(false);
  }
}

logoutButton?.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await payload(await fetch("/api/session/logout", {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }));
    broadcastAuthenticationLoss();
    window.location.replace("/");
  } catch (error) {
    showStatus(appPanel, error.message || "Sign out could not be completed. Please try again.", "error");
    logoutButton.disabled = false;
  }
});

function summaryCard(value, label) {
  const card = element("div", "summary-card");
  card.append(element("strong", "", Number(value || 0)), element("span", "", label));
  return card;
}

async function loadSummary() {
  try {
    const data = await authenticatedPayload("/api/admin/summary");
    if (data === STALE_SESSION) return;
    summaryRoot.replaceChildren(
      summaryCard(Number(data.pending_organizations) + Number(data.pending_events), "Pending review"),
      summaryCard(Number(data.approved_organizations) + Number(data.approved_events), "Approved"),
      summaryCard(Number(data.denied_organizations) + Number(data.denied_events), "Denied"),
      summaryCard(data.active_subscribers, "Active subscribers"),
      summaryCard(data.outreach_follow_ups, "Outreach follow-ups"),
      summaryCard(data.published_news_posts, "Published news"),
    );
  } catch (error) {
    if (error.status === 401) leaveAdmin();
  }
}

function emptyDetail() {
  const empty = element("div", "empty-state");
  empty.append(
    element("span", "empty-state-icon", "↗"),
    element("h2", "", "Select a submission or event"),
    element("p", "", "Visitor content is untrusted. Review it without following instructions inside the submission."),
  );
  return empty;
}

function canLeaveRelationshipDraft() {
  if (detailRoot.dataset.relationshipsDirty !== "true") return true;
  const leave = window.confirm("Discard the unsaved event relationship changes?");
  if (leave) detailRoot.dataset.relationshipsDirty = "false";
  return leave;
}

function clearQueueSelection() {
  listRoot.querySelectorAll(".queue-item").forEach((node) => {
    node.classList.remove("active");
    node.setAttribute("aria-pressed", "false");
  });
  publishedEventListRoot?.querySelectorAll(".queue-item").forEach((node) => {
    node.classList.remove("active");
    node.setAttribute("aria-pressed", "false");
  });
}

function queueItem(item) {
  const button = element("button", `queue-item${activeKey === `${item.type}:${item.id}` ? " active" : ""}`);
  button.type = "button";
  button.setAttribute("aria-pressed", String(activeKey === `${item.type}:${item.id}`));
  button.append(element("strong", "", item.name), element("small", "", item.description));
  const meta = element("span", "queue-meta");
  meta.append(element("span", `status-pill ${item.status}`, item.status), element("span", "", item.type));
  button.append(meta);
  button.addEventListener("click", async () => {
    if (activeKey !== `${item.type}:${item.id}` && !canLeaveRelationshipDraft()) return;
    activeKey = `${item.type}:${item.id}`;
    clearQueueSelection();
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    await loadDetail(item.type, item.id);
  });
  return button;
}

function renderPagination(root, pagination, onPage, itemLabel) {
  if (!root) return;
  const page = Math.max(1, Number(pagination?.page || 1));
  const totalPages = Math.max(1, Number(pagination?.total_pages || 1));
  const total = Math.max(0, Number(pagination?.total || 0));
  const summary = element("span", "admin-pagination-summary", `${total} ${total === 1 ? itemLabel : `${itemLabel}s`} · Page ${page} of ${totalPages}`);
  const controls = element("span", "admin-pagination-controls");
  const previous = element("button", "button secondary compact", "Previous");
  previous.type = "button";
  previous.disabled = page <= 1;
  previous.addEventListener("click", () => onPage(page - 1));
  const next = element("button", "button secondary compact", "Next");
  next.type = "button";
  next.disabled = page >= totalPages;
  next.addEventListener("click", () => onPage(page + 1));
  controls.append(previous, next);
  root.replaceChildren(summary, controls);
}

async function loadList() {
  const query = new URLSearchParams({ status: statusFilter.value, type: typeFilter.value, page: String(submissionPage), per_page: "20" });
  try {
    const data = await authenticatedPayload(`/api/admin/submissions?${query}`);
    if (data === STALE_SESSION) return;
    const items = data.submissions || [];
    listRoot.replaceChildren(...(items.length ? items.map(queueItem) : [element("div", "empty-state", "No submissions in this view.")]));
    renderPagination(submissionPaginationRoot, data.pagination, async (page) => {
      if (!canLeaveRelationshipDraft()) return;
      submissionPage = page;
      activeKey = "";
      detailRoot.replaceChildren(emptyDetail());
      await loadList();
      listRoot.querySelector("button")?.focus();
    }, "submission");
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else listRoot.replaceChildren(element("div", "empty-state", error.message));
  }
}

let previousStatusFilter = statusFilter?.value || "pending";
let previousTypeFilter = typeFilter?.value || "all";

async function filterChanged(event) {
  if (!canLeaveRelationshipDraft()) {
    statusFilter.value = previousStatusFilter;
    typeFilter.value = previousTypeFilter;
    return;
  }
  previousStatusFilter = statusFilter.value;
  previousTypeFilter = typeFilter.value;
  submissionPage = 1;
  activeKey = "";
  detailRequestGeneration += 1;
  clearQueueSelection();
  detailRoot.replaceChildren(emptyDetail());
  await loadList();
}

statusFilter?.addEventListener("change", filterChanged);
typeFilter?.addEventListener("change", filterChanged);

function publishedEventQueueItem(item) {
  const key = `published-event:${item.id}`;
  const button = element("button", `queue-item${activeKey === key ? " active" : ""}`);
  button.type = "button";
  button.setAttribute("aria-pressed", String(activeKey === key));
  button.append(
    element("strong", "", item.name),
    element("small", "", readableDate(item.start_at)),
  );
  const meta = element("span", "queue-meta");
  const count = Number(item.organization_count || 0);
  meta.append(
    element("span", "status-pill approved", "published"),
    element("span", "", `${count} ${count === 1 ? "organization" : "organizations"}`),
  );
  button.append(meta);
  button.addEventListener("click", async () => {
    if (activeKey !== key && !canLeaveRelationshipDraft()) return;
    activeKey = key;
    clearQueueSelection();
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    await loadPublishedEventDetail(item.id);
  });
  return button;
}

async function loadPublishedEvents() {
  if (!publishedEventListRoot) return;
  try {
    const query = new URLSearchParams({ page: String(publishedEventPage), per_page: "20" });
    const data = await authenticatedPayload(`/api/admin/events?${query}`);
    if (data === STALE_SESSION) return;
    const events = data.events || [];
    publishedEventListRoot.replaceChildren(...(
      events.length
        ? events.map(publishedEventQueueItem)
        : [element("div", "empty-state", "No published events are available.")]
    ));
    renderPagination(publishedEventPaginationRoot, data.pagination, async (page) => {
      if (!canLeaveRelationshipDraft()) return;
      publishedEventPage = page;
      activeKey = "";
      detailRoot.replaceChildren(emptyDetail());
      await loadPublishedEvents();
      publishedEventListRoot.querySelector("button")?.focus();
    }, "event");
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else publishedEventListRoot.replaceChildren(element("div", "empty-state", error.message));
  }
}

function detailField(label, value, full = false) {
  const wrapper = element("div", `detail-field${full ? " full" : ""}`);
  wrapper.append(element("span", "", label), element("p", "", value || "—"));
  return wrapper;
}

function readableDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-BS", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Nassau" }).format(date);
}

function detailFields(submission) {
  const fields = element("div", "detail-fields");
  fields.append(
    detailField("Private submitter email", submission.submitter_email),
    detailField("Private submitter phone", submission.submitter_phone),
    detailField("Website", submission.website, true),
    detailField("Description", submission.description, true),
    detailField("Additional details", submission.details, true),
  );
  if (submission.type === "organization") {
    const locations = (submission.locations || []).map((item) => `${item.city}, ${item.island}`).join(" · ");
    const categories = (submission.categories || []).map((item) => item.name).join(" · ");
    const publicContacts = (submission.public_contacts || [])
      .map((item) => `${item.label}: ${item.value}${item.is_primary ? " (primary)" : ""}`)
      .join("\n");
    fields.append(
      detailField("Public contact list", publicContacts, true),
      detailField("Listed locations", locations),
      detailField("Proposed new location", submission.new_location),
      detailField("Categories", categories, true),
    );
    for (const section of submission.sections || []) {
      fields.append(detailField(section.heading, section.body_text, true));
    }
  } else {
    const listed = submission.location_city ? `${submission.location_city}, ${submission.location_island}` : "";
    fields.append(
      detailField("Intended public email", submission.public_email),
      detailField("Intended public phone", submission.public_phone),
      detailField("Starts", readableDate(submission.start_at)),
      detailField("Ends", readableDate(submission.end_at)),
      detailField("Venue", submission.venue_name),
      detailField("Location", listed || submission.new_location),
    );
  }
  return fields;
}

function historyList(history) {
  const root = element("div", "history-list");
  for (const item of history || []) {
    const row = element("div", "history-item");
    row.append(element("strong", "", `${item.action} · ${readableDate(item.created_at)}`));
    if (item.actor_name) row.append(element("small", "", ` by ${item.actor_name}`));
    if (item.reason) row.append(element("p", "", `Reason: ${item.reason}`));
    if (item.private_notes) row.append(element("p", "", `Private notes: ${item.private_notes}`));
    root.append(row);
  }
  return root;
}

function moderationControls(submission) {
  const wrapper = element("div", "moderation-form");
  const reasonLabel = element("label", "", "Review reason");
  const reason = element("input");
  reason.name = "reason";
  reason.maxLength = 500;
  reason.placeholder = submission.status === "pending" ? "Required when denying" : "Optional restoration note";
  reasonLabel.append(reason);
  const notesLabel = element("label", "", "Private reviewer notes");
  const notes = element("textarea");
  notes.name = "private_notes";
  notes.maxLength = 2000;
  notes.rows = 3;
  notesLabel.append(notes);
  const status = element("div", "form-status");
  status.hidden = true;
  const actions = element("div", "moderation-actions");
  if (submission.status === "pending") {
    const approve = element("button", "button primary", "Approve and publish");
    approve.type = "button";
    approve.addEventListener("click", () => mutateSubmission(submission, "approve", reason.value, notes.value, wrapper));
    const deny = element("button", "button danger", "Deny");
    deny.type = "button";
    deny.addEventListener("click", () => mutateSubmission(submission, "deny", reason.value, notes.value, wrapper));
    actions.append(approve, deny);
  } else if (submission.status === "denied") {
    const restore = element("button", "button secondary", "Restore to pending");
    restore.type = "button";
    restore.addEventListener("click", () => mutateSubmission(submission, "restore", reason.value, notes.value, wrapper));
    actions.append(restore);
  } else {
    wrapper.append(element("p", "", "This submission has already been published. Public records are managed separately from the original review decision."));
    return wrapper;
  }
  wrapper.append(reasonLabel, notesLabel, actions, status);
  return wrapper;
}

const EVENT_RELATIONSHIP_ROLES = ["host", "organizer", "partner", "beneficiary"];

function organizationRelationshipEditor(submission) {
  const wrapper = element("div", "moderation-form event-organization-editor");
  const explanation = element("p", "", "Review organizations connected to this event. An event may remain standalone, and at most one organization may be primary.");
  const rows = element("div", "event-organization-rows");
  const status = element("div", "form-status");
  status.hidden = true;
  detailRoot.dataset.relationshipsDirty = "false";
  let relationshipRowSequence = 0;

  function markDirty() {
    detailRoot.dataset.relationshipsDirty = "true";
    showStatus(wrapper, "Save relationship changes before leaving this event.", "error");
  }

  function relationshipRow(link = {}) {
    const rowNumber = ++relationshipRowSequence;
    const row = element("div", "event-organization-row");
    const organizationLabel = element("label", "", "Organization");
    const organization = element("select");
    organization.className = "event-organization-select";
    organization.setAttribute("aria-label", `Organization for relationship ${rowNumber}`);
    const empty = element("option", "", "Choose organization");
    empty.value = "";
    organization.append(empty);
    for (const item of submission.available_organizations || []) {
      const option = element("option", "", item.name);
      option.value = item.id;
      option.selected = item.id === link.id;
      organization.append(option);
    }
    organizationLabel.append(organization);

    const roleLabel = element("label", "", "Role");
    const role = element("select");
    role.className = "event-organization-role";
    role.setAttribute("aria-label", `Role for relationship ${rowNumber}`);
    for (const value of EVENT_RELATIONSHIP_ROLES) {
      const option = element("option", "", value[0].toUpperCase() + value.slice(1));
      option.value = value;
      option.selected = value === (link.role || "organizer");
      role.append(option);
    }
    roleLabel.append(role);

    const primaryLabel = element("label", "event-organization-primary");
    const primary = element("input");
    primary.type = "checkbox";
    primary.setAttribute("aria-label", `Make relationship ${rowNumber} the primary organization`);
    primary.checked = Boolean(link.is_primary);
    primary.addEventListener("change", () => {
      if (primary.checked) {
        rows.querySelectorAll('.event-organization-primary input[type="checkbox"]').forEach((candidate) => {
          if (candidate !== primary) candidate.checked = false;
        });
      }
    });
    primaryLabel.append(primary, document.createTextNode(" Primary"));

    organization.addEventListener("change", () => {
      if (!organization.value) return;
      const duplicate = [...rows.querySelectorAll(".event-organization-select")]
        .some((candidate) => candidate !== organization && candidate.value === organization.value);
      if (duplicate) {
        organization.value = "";
        showStatus(wrapper, "Each organization can be linked only once.", "error");
      }
    });

    const remove = element("button", "button secondary", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove organization relationship ${rowNumber}`);
    remove.addEventListener("click", () => {
      row.remove();
      markDirty();
    });
    row.append(organizationLabel, roleLabel, primaryLabel, remove);
    return row;
  }

  const links = submission.organizations || [];
  rows.append(...links.map(relationshipRow));
  const actions = element("div", "moderation-actions");
  const add = element("button", "button secondary", "Add organization");
  add.type = "button";
  add.addEventListener("click", () => {
    const row = relationshipRow();
    rows.append(row);
    markDirty();
    row.querySelector("select")?.focus();
  });
  rows.addEventListener("change", markDirty);
  const save = element("button", "button primary", "Save relationships");
  save.type = "button";
  save.addEventListener("click", async () => {
    const controls = [...wrapper.querySelectorAll("button, select, input")];
    controls.forEach((control) => { control.disabled = true; });
    try {
      const organizations = [...rows.querySelectorAll(".event-organization-row")].map((row) => ({
        organization_id: row.querySelector(".event-organization-select").value,
        role: row.querySelector(".event-organization-role").value,
        is_primary: row.querySelector('input[type="checkbox"]').checked,
      })).filter((link) => link.organization_id);
      const endpoint = submission.status === "approved" && submission.published_event_id
        ? `/api/admin/events/${encodeURIComponent(submission.published_event_id)}/organizations`
        : `/api/admin/submissions/event/${encodeURIComponent(submission.id)}/organizations`;
      const result = await authenticatedPayload(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ organizations }),
      });
      if (result === STALE_SESSION) return;
      detailRoot.dataset.relationshipsDirty = "false";
      showStatus(wrapper, "Event relationships saved.", "success");
      await loadPublishedEvents();
      if (submission.relationship_context === "published_event") {
        await loadPublishedEventDetail(submission.published_event_id);
      } else {
        await loadDetail("event", submission.id);
      }
    } catch (error) {
      if (error.status === 401) leaveAdmin();
      else showStatus(wrapper, error.message, "error");
    } finally {
      controls.forEach((control) => { control.disabled = false; });
    }
  });
  actions.append(add, save);
  wrapper.append(explanation, rows, actions, status);
  return wrapper;
}

async function mutateSubmission(submission, action, reason, notes, container) {
  if (action === "deny" && !String(reason || "").trim()) {
    showStatus(container, "Add a review reason before denying this submission.", "error");
    container.querySelector('[name="reason"]')?.focus();
    return;
  }
  if (
    action === "approve" &&
    submission.type === "event" &&
    detailRoot.dataset.relationshipsDirty === "true"
  ) {
    showStatus(container, "Save the event relationships before approving and publishing.", "error");
    return;
  }
  const confirmation = action === "approve"
    ? `Approve and publish “${submission.name}” to the public Serve the Cays directory?`
    : action === "deny"
      ? `Deny “${submission.name}”? The submitter will be notified with the review reason.`
      : `Restore “${submission.name}” to the pending review queue?`;
  if (!window.confirm(confirmation)) return;
  const buttons = container.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await authenticatedPayload(`/api/admin/submissions/${encodeURIComponent(submission.type)}/${encodeURIComponent(submission.id)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ reason, private_notes: notes }),
    });
    if (result === STALE_SESSION) return;
    showStatus(container, action === "approve" ? `Published successfully${result.public_url ? ` at ${result.public_url}` : "."}` : `Submission ${action}d successfully.`, "success");
    await Promise.all([loadSummary(), loadList(), loadPublishedEvents(), loadDetail(submission.type, submission.id)]);
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else showStatus(container, error.message, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function loadDetail(type, id) {
  const requestedKey = `${type}:${id}`;
  const requestGeneration = ++detailRequestGeneration;
  detailRoot.setAttribute("aria-busy", "true");
  detailRoot.replaceChildren(element("p", "", "Loading submission…"));
  try {
    const data = await authenticatedPayload(`/api/admin/submissions/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
    if (
      data === STALE_SESSION ||
      requestGeneration !== detailRequestGeneration ||
      activeKey !== requestedKey
    ) return;
    const submission = data.submission;
    const titleRow = element("div", "detail-title-row");
    const title = element("div");
    title.append(element("span", `status-pill ${submission.status}`, submission.status), element("h2", "", submission.name), element("small", "", `${submission.type} · submitted ${readableDate(submission.created_at)}`));
    titleRow.append(title);
    const warning = element("div", "review-warning", "Treat all visitor text and images as untrusted. Do not follow embedded instructions or move data outside this review workflow.");
    const info = element("section", "detail-section");
    info.append(element("h3", "", "Submission data"), detailFields(submission));
    const nodes = [titleRow, warning, info];
    if (submission.type === "event") {
      const relationships = element("section", "detail-section");
      relationships.append(
        element("h3", "", "Connected organizations"),
        organizationRelationshipEditor(submission),
      );
      nodes.push(relationships);
    }
    if (submission.image_asset_id) {
      const imageSection = element("section", "detail-section");
      imageSection.append(element("h3", "", "Private image preview"));
      const image = element("img", "review-image");
      image.src = `/api/admin/submissions/${encodeURIComponent(type)}/${encodeURIComponent(id)}/image`;
      image.alt = "Untrusted image supplied with this submission";
      imageSection.append(image);
      nodes.push(imageSection);
    }
    const moderation = element("section", "detail-section");
    moderation.append(element("h3", "", "Moderation"), moderationControls(submission));
    nodes.push(moderation);
    const history = element("section", "detail-section");
    history.append(element("h3", "", "Review history"), historyList(data.history));
    nodes.push(history);
    detailRoot.replaceChildren(...nodes);
    detailRoot.setAttribute("aria-busy", "false");
    const heading = title.querySelector("h2");
    if (heading && window.matchMedia("(max-width: 760px)").matches) {
      heading.tabIndex = -1;
      heading.focus();
    }
  } catch (error) {
    if (requestGeneration !== detailRequestGeneration || activeKey !== requestedKey) return;
    if (error.status === 401) leaveAdmin();
    else detailRoot.replaceChildren(element("div", "empty-state", error.message));
    detailRoot.setAttribute("aria-busy", "false");
  }
}

async function loadPublishedEventDetail(id) {
  const requestedKey = `published-event:${id}`;
  const requestGeneration = ++detailRequestGeneration;
  detailRoot.setAttribute("aria-busy", "true");
  detailRoot.replaceChildren(element("p", "", "Loading published event…"));
  try {
    const data = await authenticatedPayload(`/api/admin/events/${encodeURIComponent(id)}/organizations`);
    if (
      data === STALE_SESSION ||
      requestGeneration !== detailRequestGeneration ||
      activeKey !== requestedKey
    ) return;
    const event = data.event;
    const editorRecord = {
      ...event,
      type: "event",
      status: "approved",
      published_event_id: event.id,
      relationship_context: "published_event",
    };
    const titleRow = element("div", "detail-title-row");
    const title = element("div");
    title.append(
      element("span", "status-pill approved", "published"),
      element("h2", "", event.name),
      element("small", "", `event · ${readableDate(event.start_at)}`),
    );
    const publicLink = element("a", "button secondary compact", "Open public event");
    publicLink.href = `/event/${encodeURIComponent(event.id)}`;
    titleRow.append(title, publicLink);
    const info = element("section", "detail-section");
    const fields = element("div", "detail-fields");
    fields.append(
      detailField("Starts", readableDate(event.start_at)),
      detailField("Ends", readableDate(event.end_at)),
      detailField("Venue", event.venue_name),
      detailField("Location", event.location_display),
      detailField("Description", event.description, true),
    );
    info.append(element("h3", "", "Published event"), fields);
    const relationships = element("section", "detail-section");
    relationships.append(
      element("h3", "", "Connected organizations"),
      organizationRelationshipEditor(editorRecord),
    );
    detailRoot.replaceChildren(titleRow, info, relationships);
    detailRoot.setAttribute("aria-busy", "false");
    const heading = title.querySelector("h2");
    if (heading && window.matchMedia("(max-width: 760px)").matches) {
      heading.tabIndex = -1;
      heading.focus();
    }
  } catch (error) {
    if (requestGeneration !== detailRequestGeneration || activeKey !== requestedKey) return;
    if (error.status === 401) leaveAdmin();
    else detailRoot.replaceChildren(element("div", "empty-state", error.message));
    detailRoot.setAttribute("aria-busy", "false");
  }
}

function contentEmpty(title, message) {
  const empty = element("div", "empty-state");
  empty.append(element("h2", "", title), element("p", "", message));
  return empty;
}

function formField(labelText, control, className = "") {
  const label = element("label", className);
  label.append(element("span", "", labelText), control);
  return label;
}

function inputControl(name, value = "", type = "text") {
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value || "";
  return input;
}

function textareaControl(name, value = "", rows = 5) {
  const textarea = document.createElement("textarea");
  textarea.name = name;
  textarea.rows = rows;
  textarea.value = value || "";
  return textarea;
}

function selectControl(name, options, selected = "") {
  const select = document.createElement("select");
  select.name = name;
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    select.append(option);
  }
  return select;
}

function localDateTime(value = new Date().toISOString()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formDataObject(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const key of ["next_follow_up_at", "occurred_at"]) {
    if (data[key]) data[key] = new Date(String(data[key])).toISOString();
  }
  return data;
}

async function adminMutation(url, method, body) {
  return authenticatedPayload(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body || {}),
  });
}

function activateAdminView(view) {
  for (const button of viewButtons) {
    const active = button.dataset.adminViewButton === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of viewPanels) panel.hidden = panel.dataset.adminView !== view;
}

for (const button of viewButtons) {
  button.addEventListener("click", () => activateAdminView(button.dataset.adminViewButton));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = viewButtons.indexOf(button);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? viewButtons.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + viewButtons.length) % viewButtons.length;
    const nextButton = viewButtons[next];
    activateAdminView(nextButton.dataset.adminViewButton);
    nextButton.focus();
  });
}

function outreachQueueItem(contact) {
  const button = element("button", `queue-item${activeOutreachId === contact.id ? " active" : ""}`);
  button.type = "button";
  button.setAttribute("aria-pressed", String(activeOutreachId === contact.id));
  button.append(
    element("strong", "", contact.organization_name),
    element("small", "", contact.contact_name || contact.contact_email || contact.contact_phone || "Contact details pending"),
  );
  const meta = element("span", "queue-meta");
  meta.append(
    element("span", `status-pill ${contact.status}`, String(contact.status || "").replaceAll("_", " ")),
    element("span", "", `${Number(contact.activity_count || 0)} activities`),
  );
  button.append(meta);
  button.addEventListener("click", async () => {
    activeOutreachId = contact.id;
    outreachListRoot.querySelectorAll(".queue-item").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    await loadOutreachDetail(contact.id);
  });
  return button;
}

async function loadOutreach() {
  if (!outreachListRoot) return;
  const query = new URLSearchParams({
    status: outreachStatusFilter.value,
    search: outreachSearch.value.trim(),
    page: String(outreachPage),
    per_page: "20",
  });
  try {
    const data = await authenticatedPayload(`/api/admin/outreach?${query}`);
    if (data === STALE_SESSION) return;
    outreachOrganizations = data.organizations || [];
    const contacts = data.contacts || [];
    outreachListRoot.replaceChildren(...(
      contacts.length
        ? contacts.map(outreachQueueItem)
        : [element("div", "empty-state", "No outreach contacts in this view.")]
    ));
    renderPagination(outreachPaginationRoot, data.pagination, async (page) => {
      outreachPage = page;
      activeOutreachId = "";
      outreachDetailRoot.replaceChildren(contentEmpty("Select an outreach contact", "Every recorded interaction remains in the append-only activity history."));
      await loadOutreach();
    }, "contact");
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else outreachListRoot.replaceChildren(element("div", "empty-state", error.message));
  }
}

let outreachSearchTimer;
outreachStatusFilter?.addEventListener("change", () => {
  outreachPage = 1;
  loadOutreach();
});
outreachSearch?.addEventListener("input", () => {
  clearTimeout(outreachSearchTimer);
  outreachSearchTimer = setTimeout(() => {
    outreachPage = 1;
    loadOutreach();
  }, 250);
});

function outreachForm(contact = null) {
  const form = element("form", "content-admin-form");
  const grid = element("div", "content-admin-form-grid");
  const organizationOptions = [
    ["", "Other or unlisted organization"],
    ...outreachOrganizations.map((organization) => [organization.id, organization.name]),
  ];
  const organizationSelect = selectControl("organization_id", organizationOptions, contact?.organization_id || "");
  const organizationName = inputControl("organization_name", contact?.organization_name || "");
  organizationName.maxLength = 200;
  const contactName = inputControl("contact_name", contact?.contact_name || "");
  contactName.maxLength = 200;
  const email = inputControl("contact_email", contact?.contact_email || "", "email");
  email.maxLength = 254;
  const phone = inputControl("contact_phone", contact?.contact_phone || "", "tel");
  phone.maxLength = 100;
  const status = selectControl("status", [
    ["not_contacted", "Not contacted"],
    ["contacted", "Contacted"],
    ["responded", "Responded"],
    ["follow_up", "Follow up"],
    ["closed", "Closed"],
  ], contact?.status || "not_contacted");
  const followUp = inputControl("next_follow_up_at", contact?.next_follow_up_at ? localDateTime(contact.next_follow_up_at) : "", "datetime-local");
  const notes = textareaControl("private_notes", contact?.private_notes || "", 5);
  notes.maxLength = 5000;
  grid.append(
    formField("Listed organization", organizationSelect),
    formField("Organization name", organizationName),
    formField("Contact name", contactName),
    formField("Email", email),
    formField("Phone", phone),
    formField("Status", status),
    formField("Next follow-up", followUp),
    formField("Private notes", notes, "full"),
  );
  const statusBox = element("div", "form-status");
  statusBox.hidden = true;
  const actions = element("div", "content-admin-form-actions");
  const save = element("button", "button", contact ? "Save contact" : "Create contact");
  save.type = "submit";
  actions.append(save);
  form.append(grid, statusBox, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await adminMutation(
        contact ? `/api/admin/outreach/${encodeURIComponent(contact.id)}` : "/api/admin/outreach",
        contact ? "PUT" : "POST",
        formDataObject(form),
      );
      if (result === STALE_SESSION) return;
      showStatus(form, contact ? "Contact saved." : "Contact created.", "success");
      activeOutreachId = contact?.id || result.id;
      await Promise.all([loadOutreach(), loadSummary()]);
      await loadOutreachDetail(activeOutreachId);
    } catch (error) {
      if (error.status === 401) leaveAdmin();
      else showStatus(form, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

function outreachActivityForm(contact) {
  const form = element("form", "outreach-activity-form");
  const type = selectControl("activity_type", [
    ["email_sent", "Email sent"],
    ["email_received", "Email received"],
    ["phone_call", "Phone call"],
    ["meeting", "Meeting"],
    ["note", "Note"],
  ], "email_sent");
  const occurredAt = inputControl("occurred_at", localDateTime(), "datetime-local");
  const subject = inputControl("subject", "");
  subject.maxLength = 500;
  const details = textareaControl("details", "", 4);
  details.maxLength = 5000;
  const evidence = inputControl("evidence_reference", "");
  evidence.maxLength = 1000;
  const evidenceField = formField("Evidence reference", evidence);
  evidenceField.append(element("p", "content-admin-help", "Required for sent email. Use a sent-mail link, message ID, or provider reference."));
  const grid = element("div", "content-admin-form-grid");
  grid.append(
    formField("Activity", type),
    formField("Occurred", occurredAt),
    formField("Subject", subject, "full"),
    formField("Details", details, "full"),
    evidenceField,
  );
  evidenceField.classList.add("full");
  const statusBox = element("div", "form-status");
  statusBox.hidden = true;
  const save = element("button", "button", "Record activity");
  save.type = "submit";
  const actions = element("div", "content-admin-form-actions");
  actions.append(save);
  form.append(grid, statusBox, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await adminMutation(
        `/api/admin/outreach/${encodeURIComponent(contact.id)}/activities`,
        "POST",
        formDataObject(form),
      );
      if (result === STALE_SESSION) return;
      await Promise.all([loadOutreach(), loadOutreachDetail(contact.id), loadSummary()]);
    } catch (error) {
      if (error.status === 401) leaveAdmin();
      else showStatus(form, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

function outreachHistory(activities) {
  const history = element("div", "outreach-history");
  if (!activities.length) {
    history.append(element("p", "content-admin-help", "No outreach activity has been recorded yet."));
    return history;
  }
  for (const activity of activities) {
    const item = element("article", `outreach-activity ${activity.activity_type}`);
    const title = activity.activity_type === "status_change"
      ? `${String(activity.previous_status).replaceAll("_", " ")} → ${String(activity.new_status).replaceAll("_", " ")}`
      : String(activity.activity_type).replaceAll("_", " ");
    item.append(element("h4", "", activity.subject || title));
    if (activity.details) item.append(element("p", "", activity.details));
    if (activity.evidence_reference) item.append(element("p", "outreach-evidence", `Evidence: ${activity.evidence_reference}`));
    item.append(element("small", "", `${readableDate(activity.occurred_at)} · ${activity.actor_name || activity.actor_email || "Administrator"}`));
    history.append(item);
  }
  return history;
}

async function loadOutreachDetail(id) {
  outreachDetailRoot.setAttribute("aria-busy", "true");
  try {
    const data = await authenticatedPayload(`/api/admin/outreach/${encodeURIComponent(id)}`);
    if (data === STALE_SESSION || id !== activeOutreachId) return;
    const contact = data.contact;
    const title = element("div", "detail-title-row");
    const heading = element("div");
    heading.append(
      element("span", "eyebrow", "Outreach contact"),
      element("h2", "", contact.organization_name),
      element("small", "", contact.contact_name || contact.contact_email || contact.contact_phone),
    );
    title.append(heading, element("span", `status-pill ${contact.status}`, String(contact.status).replaceAll("_", " ")));
    const contactSection = element("section", "detail-section");
    contactSection.append(element("h3", "", "Contact record"), outreachForm(contact));
    const activitySection = element("section", "detail-section");
    activitySection.append(element("h3", "", "Record an interaction"), outreachActivityForm(contact));
    const historySection = element("section", "detail-section");
    historySection.append(element("h3", "", "Append-only history"), outreachHistory(data.activities || []));
    outreachDetailRoot.replaceChildren(title, contactSection, activitySection, historySection);
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else outreachDetailRoot.replaceChildren(contentEmpty("Outreach contact unavailable", error.message));
  } finally {
    outreachDetailRoot.setAttribute("aria-busy", "false");
  }
}

newOutreachButton?.addEventListener("click", () => {
  activeOutreachId = "";
  const title = element("div", "detail-title-row");
  const heading = element("div");
  heading.append(element("span", "eyebrow", "Outreach ledger"), element("h2", "", "New outreach contact"));
  title.append(heading);
  outreachDetailRoot.replaceChildren(title, outreachForm());
});

function newsQueueItem(post) {
  const button = element("button", `queue-item${activeNewsId === post.id ? " active" : ""}`);
  button.type = "button";
  button.setAttribute("aria-pressed", String(activeNewsId === post.id));
  button.append(element("strong", "", post.title), element("small", "", post.summary));
  const meta = element("span", "queue-meta");
  meta.append(element("span", `status-pill ${post.status}`, post.status), element("span", "", readableDate(post.updated_at)));
  button.append(meta);
  button.addEventListener("click", async () => {
    activeNewsId = post.id;
    newsListRoot.querySelectorAll(".queue-item").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    await loadNewsDetail(post.id);
  });
  return button;
}

async function loadNews() {
  if (!newsListRoot) return;
  const query = new URLSearchParams({ status: newsStatusFilter.value, page: String(newsPage), per_page: "20" });
  try {
    const data = await authenticatedPayload(`/api/admin/news?${query}`);
    if (data === STALE_SESSION) return;
    const posts = data.posts || [];
    newsListRoot.replaceChildren(...(posts.length ? posts.map(newsQueueItem) : [element("div", "empty-state", "No news posts in this view.")]));
    renderPagination(newsPaginationRoot, data.pagination, async (page) => {
      newsPage = page;
      activeNewsId = "";
      newsDetailRoot.replaceChildren(contentEmpty("Select a news post", "Posts remain private drafts until an administrator explicitly publishes them."));
      await loadNews();
    }, "post");
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else newsListRoot.replaceChildren(element("div", "empty-state", error.message));
  }
}

newsStatusFilter?.addEventListener("change", () => {
  newsPage = 1;
  loadNews();
});

function newsForm(post = null) {
  const form = element("form", "content-admin-form");
  const grid = element("div", "content-admin-form-grid");
  const title = inputControl("title", post?.title || "");
  title.maxLength = 200;
  title.required = true;
  const summary = textareaControl("summary", post?.summary || "", 3);
  summary.maxLength = 500;
  summary.required = true;
  const body = textareaControl("body_text", post?.body_text || "", 14);
  body.maxLength = 50000;
  body.required = true;
  grid.append(formField("Title", title, "full"), formField("Summary", summary, "full"), formField("Post content", body, "full"));
  const help = element("p", "content-admin-help", "Use blank lines to separate paragraphs. Content is published as safe plain text.");
  const statusBox = element("div", "form-status");
  statusBox.hidden = true;
  const actions = element("div", "content-admin-form-actions");
  const save = element("button", "button", post ? "Save post" : "Create draft");
  save.type = "submit";
  actions.append(save);
  if (post) {
    if (post.status !== "published") {
      const publish = element("button", "button secondary", "Publish");
      publish.type = "button";
      publish.addEventListener("click", () => changeNewsPostStatus(post, "publish"));
      actions.append(publish);
    } else {
      const unpublish = element("button", "button secondary", "Unpublish");
      unpublish.type = "button";
      unpublish.addEventListener("click", () => changeNewsPostStatus(post, "unpublish"));
      actions.append(unpublish);
    }
    if (post.status !== "archived") {
      const archive = element("button", "button secondary", "Archive");
      archive.type = "button";
      archive.addEventListener("click", () => changeNewsPostStatus(post, "archive"));
      actions.append(archive);
    }
  }
  form.append(grid, help, statusBox, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await adminMutation(
        post ? `/api/admin/news/${encodeURIComponent(post.id)}` : "/api/admin/news",
        post ? "PUT" : "POST",
        formDataObject(form),
      );
      if (result === STALE_SESSION) return;
      activeNewsId = post?.id || result.id;
      showStatus(form, post ? "Post saved." : "Draft created.", "success");
      await Promise.all([loadNews(), loadSummary()]);
      await loadNewsDetail(activeNewsId);
    } catch (error) {
      if (error.status === 401) leaveAdmin();
      else showStatus(form, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

async function changeNewsPostStatus(post, action) {
  const verb = action === "publish" ? "publish this post" : action === "archive" ? "archive this post" : "remove this post from the public website";
  if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
  try {
    const result = await adminMutation(`/api/admin/news/${encodeURIComponent(post.id)}/${action}`, "POST", {});
    if (result === STALE_SESSION) return;
    await Promise.all([loadNews(), loadNewsDetail(post.id), loadSummary()]);
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else showStatus(newsDetailRoot, error.message, "error");
  }
}

async function loadNewsDetail(id) {
  newsDetailRoot.setAttribute("aria-busy", "true");
  try {
    const data = await authenticatedPayload(`/api/admin/news/${encodeURIComponent(id)}`);
    if (data === STALE_SESSION || id !== activeNewsId) return;
    const post = data.post;
    const title = element("div", "detail-title-row");
    const heading = element("div");
    heading.append(element("span", "eyebrow", "News post"), element("h2", "", post.title), element("small", "", post.status === "published" ? `Published ${readableDate(post.published_at)}` : "Not public"));
    title.append(heading, element("span", `status-pill ${post.status}`, post.status));
    if (post.status === "published") {
      const link = element("a", "button secondary compact", "View public post");
      link.href = `/news/${encodeURIComponent(post.slug)}`;
      title.append(link);
    }
    newsDetailRoot.replaceChildren(title, newsForm(post));
  } catch (error) {
    if (error.status === 401) leaveAdmin();
    else newsDetailRoot.replaceChildren(contentEmpty("News post unavailable", error.message));
  } finally {
    newsDetailRoot.setAttribute("aria-busy", "false");
  }
}

newNewsButton?.addEventListener("click", () => {
  activeNewsId = "";
  const title = element("div", "detail-title-row");
  const heading = element("div");
  heading.append(element("span", "eyebrow", "News"), element("h2", "", "New draft"));
  title.append(heading);
  newsDetailRoot.replaceChildren(title, newsForm());
});

globalThis.addEventListener?.("beforeunload", (event) => {
  if (detailRoot.dataset.relationshipsDirty !== "true") return;
  event.preventDefault();
  event.returnValue = "";
});

appPanel?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!target || detailRoot.dataset.relationshipsDirty !== "true") return;
  if (!canLeaveRelationshipDraft()) event.preventDefault();
}, { capture: true });

authChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "authentication-lost") return;
  leaveAdmin(false);
});

globalThis.addEventListener?.("pageshow", (event) => {
  if (!event.persisted) return;
  const notifyPeersOnFailure = authenticated;
  sessionGeneration += 1;
  authenticated = false;
  csrfToken = "";
  clearPrivateState();
  appPanel.hidden = true;
  restoreSession(notifyPeersOnFailure);
});

restoreSession();
