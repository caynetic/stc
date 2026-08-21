const menuButton = document.querySelector(".menu-button");
const siteNav = document.querySelector(".site-nav");

if (menuButton && siteNav) {
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!open));
    siteNav.classList.toggle("open", !open);
  });
}

function statusBox(form) {
  return form.querySelector(".form-status");
}

function showStatus(form, message, kind) {
  const box = statusBox(form);
  if (!box) return;
  box.textContent = message;
  box.className = `form-status ${kind}`;
  box.hidden = false;
  if (!form.querySelector('[aria-invalid="true"]:focus')) {
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function clearErrors(form) {
  form.querySelectorAll(".field-error").forEach((element) => {
    const name = element.dataset.fieldErrorFor;
    const field = name ? form.querySelector(`[name="${CSS.escape(name)}"]`) : null;
    if (field && element.id) {
      const describedBy = (field.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .filter((id) => id && id !== element.id);
      if (describedBy.length) field.setAttribute("aria-describedby", describedBy.join(" "));
      else field.removeAttribute("aria-describedby");
    }
    element.remove();
  });
  form.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute("aria-invalid"));
  const box = statusBox(form);
  if (box) box.hidden = true;
}

function setButtonBusy(button, busy) {
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function showFieldErrors(form, errors = {}) {
  let firstInvalid = null;
  for (const [name, messages] of Object.entries(errors)) {
    const field = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!field) continue;
    if (!firstInvalid) firstInvalid = field;
    field.setAttribute("aria-invalid", "true");
    const error = document.createElement("span");
    error.className = "field-error";
    error.id = `${field.id || `field-${name.replace(/[^a-z0-9_-]/gi, "-")}`}-error`;
    error.dataset.fieldErrorFor = name;
    const describedBy = new Set((field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    describedBy.add(error.id);
    field.setAttribute("aria-describedby", [...describedBy].join(" "));
    error.textContent = Array.isArray(messages) ? messages[0] : String(messages);
    const choice = field.closest(".choice-grid");
    (choice || field).insertAdjacentElement("afterend", error);
  }
  firstInvalid?.focus();
}

const publicMenuButton = document.querySelector(".hamburger");
const publicMobileMenu = document.querySelector(".mobile-menu");
if (publicMenuButton instanceof HTMLButtonElement && publicMobileMenu) {
  const syncMenuLabel = () => {
    const open = publicMenuButton.getAttribute("aria-expanded") === "true";
    publicMenuButton.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  };
  new MutationObserver(syncMenuLabel).observe(publicMenuButton, { attributes: true, attributeFilter: ["aria-expanded"] });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && publicMenuButton.getAttribute("aria-expanded") === "true") {
      window.setTimeout(() => publicMenuButton.focus(), 0);
    }
  }, { capture: true });
  window.addEventListener("resize", () => {
    if (window.innerWidth <= 768) return;
    publicMenuButton.classList.remove("open");
    publicMenuButton.setAttribute("aria-expanded", "false");
    publicMobileMenu.classList.remove("open");
  });
  syncMenuLabel();
}

function resetTurnstile() {
  if (globalThis.turnstile && typeof globalThis.turnstile.reset === "function") {
    globalThis.turnstile.reset();
  }
}

function protectedSubmissionSignInUrl() {
  const returnPath = window.location.pathname === "/suggest/event"
    ? "/suggest/event"
    : "/suggest/organization";
  return `/signin?${new URLSearchParams({ return: returnPath }).toString()}`;
}

function protectedSubmissionForms() {
  return [...document.querySelectorAll('form[data-submission-form][data-member-required]')];
}

function submissionSuccessLink(form) {
  return form.querySelector("[data-submission-success-link]")
    || form.closest("[data-member-suggestion-page]")?.querySelector("[data-submission-success-link]")
    || document.querySelector("[data-submission-success-link]");
}

function setSubmissionSuccessLink(form, visible) {
  const link = submissionSuccessLink(form);
  if (link instanceof HTMLElement) link.hidden = !visible;
}

function resetProtectedSubmissionForm(form) {
  clearErrors(form);
  form.reset();
  for (const file of form.querySelectorAll('input[type="file"]')) file.value = "";
  const imageAlt = form.querySelector('[name="image_alt"]');
  if (imageAlt instanceof HTMLInputElement) imageAlt.required = false;
  setSubmissionSuccessLink(form, false);
  resetTurnstile();
}

function protectedSubmissionSessionReady() {
  return memberState.authenticated === true && Boolean(memberState.csrfToken);
}

function redirectProtectedSubmissionForm(form) {
  resetProtectedSubmissionForm(form);
  window.location.replace(protectedSubmissionSignInUrl());
}

function setProtectedSubmissionPending(form, pending) {
  form.setAttribute("aria-busy", String(pending));
  const submit = form.querySelector('button[type="submit"]');
  setButtonBusy(submit, pending);
}

async function initializeProtectedSubmissionForms(forms = protectedSubmissionForms()) {
  if (!forms.length) return;
  forms.forEach((form) => setProtectedSubmissionPending(form, true));
  await sessionPromise;
  if (memberSessionFailed()) {
    const globalStatus = document.querySelector("[data-member-global-status]");
    if (globalStatus) {
      globalStatus.textContent = "We couldn’t confirm your session. Please try again before sending this suggestion.";
      globalStatus.hidden = false;
    }
    return;
  }
  if (!protectedSubmissionSessionReady()) {
    forms.forEach(resetProtectedSubmissionForm);
    window.location.replace(protectedSubmissionSignInUrl());
    return;
  }
  forms.forEach((form) => setProtectedSubmissionPending(form, false));
}

function revalidateProtectedSubmissionForms() {
  const forms = protectedSubmissionForms();
  if (!forms.length) return false;
  forms.forEach((form) => {
    resetProtectedSubmissionForm(form);
    setProtectedSubmissionPending(form, true);
  });
  sessionPromise = loadMemberSession();
  void initializeProtectedSubmissionForms(forms);
  return true;
}

function offsetAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - instant.getTime();
}

function nassauLocalToIso(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const desiredUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
  let instant = new Date(desiredUtc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    instant = new Date(desiredUtc - offsetAt(instant, "America/Nassau"));
  }
  return instant.toISOString();
}

function fieldLabel(field) {
  if (!(field instanceof Element)) return "Field";
  const id = field.getAttribute("id");
  const direct = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  const wrapping = field.closest("label");
  const group = field.closest("fieldset");
  const label = direct?.textContent || wrapping?.childNodes?.[0]?.textContent || group?.querySelector(":scope > legend")?.textContent;
  return String(label || field.getAttribute("aria-label") || field.getAttribute("name") || "Field")
    .replace(/\s+/g, " ")
    .trim();
}

function initializeSearchableChoices(group) {
  const search = group.querySelector("[data-choice-search]");
  const optionsRoot = group.querySelector("[data-choice-options]");
  const chips = group.querySelector("[data-choice-chips]");
  const status = group.querySelector("[data-choice-status]");
  if (!(search instanceof HTMLInputElement) || !optionsRoot || !chips || !status) return;
  const options = [...optionsRoot.querySelectorAll("label")];
  const inputs = options.map((option) => option.querySelector('input[type="checkbox"]')).filter(Boolean);

  function sync() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    options.forEach((option) => {
      const matches = !query || option.textContent.toLocaleLowerCase().includes(query);
      option.hidden = !matches;
      if (matches) visible += 1;
    });
    const selected = inputs.filter((input) => input.checked);
    chips.replaceChildren(...selected.map((input) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "member-choice-chip";
      chip.textContent = `${input.closest("label")?.querySelector("span")?.textContent || input.value} ×`;
      chip.setAttribute("aria-label", `Remove ${input.closest("label")?.textContent?.trim() || input.value}`);
      chip.addEventListener("click", () => {
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.focus();
      });
      return chip;
    }));
    status.textContent = `${selected.length} selected · ${visible} ${visible === 1 ? "option" : "options"} shown`;
  }

  search.addEventListener("input", sync);
  optionsRoot.addEventListener("change", sync);
  group.addEventListener("stc:choices-sync", sync);
  sync();
}

document.querySelectorAll("[data-searchable-choices]").forEach(initializeSearchableChoices);

function initializeSubmissionWizard(form) {
  const steps = [...form.querySelectorAll("[data-wizard-step]")];
  const indicators = [...form.querySelectorAll("[data-wizard-indicator]")];
  const review = form.querySelector("[data-wizard-review-fields]");
  const draftStatus = form.querySelector("[data-wizard-draft-status]");
  if (!steps.length || !review) return;
  const draftKey = `stc-suggestion-draft:${form.dataset.draftKey || "suggestion"}`;
  let activeStep = 1;
  let saveTimer = 0;

  const storableControls = () => [...form.elements].filter((control) => {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return false;
    return Boolean(control.name)
      && !["file", "hidden", "submit", "button"].includes(control.type)
      && !["hp", "turnstile_token", "cf-turnstile-response", "submitter_phone"].includes(control.name);
  });

  function saveDraft() {
    const controls = storableControls();
    const values = {};
    for (const control of controls) {
      if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
        values[control.name] ||= [];
        if (control.checked) values[control.name].push(control.value);
      } else if (!(control.name in values)) {
        values[control.name] = control.value;
      }
    }
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ step: activeStep, values, savedAt: Date.now() }));
      if (draftStatus) draftStatus.textContent = "Draft saved in this browser.";
    } catch {
      if (draftStatus) draftStatus.textContent = "Draft saving is unavailable in this browser.";
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveDraft, 250);
  }

  function restoreDraft() {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (!draft?.values || typeof draft.values !== "object") return 1;
      for (const control of storableControls()) {
        if (!(control.name in draft.values)) continue;
        const value = draft.values[control.name];
        if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
          control.checked = Array.isArray(value) && value.includes(control.value);
        } else if (typeof value === "string") {
          control.value = value;
        }
      }
      form.querySelectorAll("[data-searchable-choices]").forEach((group) => group.dispatchEvent(new Event("stc:choices-sync")));
      if (draftStatus) draftStatus.textContent = "Your saved draft has been restored.";
      return Math.max(1, Math.min(4, Number(draft.step) || 1));
    } catch {
      return 1;
    }
  }

  function reviewValue(control) {
    if (control instanceof HTMLInputElement && control.type === "file") return control.files?.[0]?.name || "No image selected";
    if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
      return control.checked ? control.closest("label")?.textContent?.trim() || control.value : "";
    }
    if (control instanceof HTMLSelectElement) return control.selectedOptions[0]?.textContent?.trim() || "";
    return String(control.value || "").trim();
  }

  function buildReview() {
    const privateNames = new Set(["submitter_phone"]);
    const ignored = new Set(["hp", "turnstile_token", "cf-turnstile-response", "contact_type", "contact_label", "contact_value"]);
    const rows = [];
    const seen = new Set();
    for (const control of [...form.elements]) {
      if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
      if (!control.name || ignored.has(control.name) || control.type === "hidden" || control.type === "submit" || control.type === "button") continue;
      if (seen.has(control.name)) continue;
      const related = [...form.querySelectorAll(`[name="${CSS.escape(control.name)}"]`)];
      const values = related.map(reviewValue).filter(Boolean);
      seen.add(control.name);
      if (!values.length && control.type !== "file") continue;
      rows.push({ label: fieldLabel(control), value: values.join(" · ") || "No image selected", private: privateNames.has(control.name) });
    }
    const contactRows = [...form.querySelectorAll("[data-organization-contact-row]")].map((row) => {
      const type = row.querySelector('[name="contact_type"]')?.value;
      const label = row.querySelector('[name="contact_label"]')?.value;
      const value = row.querySelector('[name="contact_value"]')?.value;
      return [label, type, value].filter(Boolean).join(" · ");
    }).filter(Boolean);
    if (contactRows.length) rows.push({ label: "Additional public contacts", value: contactRows.join(" | "), private: false });
    review.replaceChildren(...rows.map((row) => {
      const wrapper = document.createElement("div");
      wrapper.className = `member-wizard-review-row${row.private ? " private" : ""}`;
      const term = document.createElement("dt");
      term.textContent = `${row.private ? "Private · " : "Public · "}${row.label}`;
      const detail = document.createElement("dd");
      detail.textContent = row.value;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "member-wizard-edit";
      edit.textContent = "Edit";
      const sourceStep = controlStepForName(form, row.label, controlForLabel(form, row.label));
      edit.addEventListener("click", () => showStep(sourceStep, true));
      wrapper.append(term, detail, edit);
      return wrapper;
    }));
  }

  function controlForLabel(currentForm, label) {
    return [...currentForm.elements].find((control) => fieldLabel(control) === label) || null;
  }

  function controlStepForName(currentForm, _label, control) {
    return Number(control?.closest?.("[data-wizard-step]")?.dataset.wizardStep) || 1;
  }

  function showStep(step, focus = false) {
    activeStep = Math.max(1, Math.min(4, Number(step) || 1));
    steps.forEach((section) => { section.hidden = Number(section.dataset.wizardStep) !== activeStep; });
    indicators.forEach((indicator) => {
      const current = Number(indicator.dataset.wizardIndicator) === activeStep;
      if (current) indicator.setAttribute("aria-current", "step");
      else indicator.removeAttribute("aria-current");
      indicator.classList.toggle("complete", Number(indicator.dataset.wizardIndicator) < activeStep);
    });
    if (activeStep === 4) buildReview();
    if (focus) steps[activeStep - 1]?.querySelector("h2")?.focus();
    scheduleSave();
  }

  function firstInvalidInStep(step) {
    return [...step.querySelectorAll("input, select, textarea")].find((control) => !control.checkValidity());
  }

  form.querySelectorAll("[data-wizard-next]").forEach((button) => button.addEventListener("click", () => {
    const current = steps[activeStep - 1];
    const invalid = firstInvalidInStep(current);
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    showStep(activeStep + 1, true);
  }));
  form.querySelectorAll("[data-wizard-back]").forEach((button) => button.addEventListener("click", () => showStep(activeStep - 1, true)));
  form.addEventListener("input", scheduleSave);
  form.addEventListener("change", scheduleSave);
  form.addEventListener("stc:submission-success", () => {
    window.clearTimeout(saveTimer);
    if (draftStatus) draftStatus.textContent = "Your suggestion was sent. This draft has been cleared.";
    showStep(1, false);
    window.clearTimeout(saveTimer);
    try { sessionStorage.removeItem(draftKey); } catch { /* Storage is optional. */ }
  });
  form.__stcWizard = {
    showFirstInvalid() {
      const invalid = [...form.elements].find((control) => typeof control.checkValidity === "function" && !control.checkValidity());
      if (!invalid) return false;
      showStep(Number(invalid.closest("[data-wizard-step]")?.dataset.wizardStep) || 1, false);
      invalid.reportValidity();
      invalid.focus();
      return true;
    },
  };
  showStep(restoreDraft(), false);
}

document.querySelectorAll("[data-submission-wizard]").forEach(initializeSubmissionWizard);

for (const editor of document.querySelectorAll("[data-organization-contact-editor]")) {
  const list = editor.querySelector("[data-organization-contact-list]");
  const template = editor.querySelector("[data-organization-contact-template]");
  const addButton = editor.querySelector("[data-add-organization-contact]");
  if (!list || !(template instanceof HTMLTemplateElement) || !(addButton instanceof HTMLButtonElement)) continue;

  const rows = () => [...list.querySelectorAll("[data-organization-contact-row]")];
  const syncRows = () => {
    const currentRows = rows();
    currentRows.forEach((row, index) => {
      const legend = row.querySelector("legend");
      if (legend) legend.textContent = `Additional public contact ${index + 1}`;
      for (const field of row.querySelectorAll("select, input")) {
        const base = field.name === "contact_type" ? "Contact type" : field.name === "contact_label" ? "Contact label" : "Contact detail";
        field.setAttribute("aria-label", `${base} ${index + 1}`);
      }
    });
    addButton.disabled = currentRows.length >= 10;
  };

  const syncValueControl = (row) => {
    const type = row.querySelector('[name="contact_type"]');
    const value = row.querySelector('[name="contact_value"]');
    if (!(type instanceof HTMLSelectElement) || !(value instanceof HTMLInputElement)) return;
    value.type = type.value === "email" ? "email" : type.value === "phone" ? "tel" : "text";
    value.inputMode = type.value === "email" ? "email" : type.value === "phone" ? "tel" : "text";
    value.placeholder = type.value === "email" ? "team@example.org" : type.value === "phone" ? "+1 242 555 0123" : "Email address or phone number";
  };

  addButton.addEventListener("click", () => {
    if (rows().length >= 10) return;
    const fragment = template.content.cloneNode(true);
    list.append(fragment);
    syncRows();
    rows().at(-1)?.querySelector("select")?.focus();
  });

  list.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.name !== "contact_type") return;
    const row = target.closest("[data-organization-contact-row]");
    if (row) syncValueControl(row);
  });

  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const remove = target.closest("[data-remove-organization-contact]");
    if (!remove) return;
    const row = remove.closest("[data-organization-contact-row]");
    if (!row) return;
    if (rows().length === 1) {
      for (const field of row.querySelectorAll("input, select")) field.value = "";
      syncValueControl(row);
      row.querySelector("select")?.focus();
    } else {
      const nextFocus = row.previousElementSibling?.querySelector("select") || row.nextElementSibling?.querySelector("select") || addButton;
      row.remove();
      syncRows();
      nextFocus?.focus();
    }
  });

  editor.closest("form")?.addEventListener("reset", () => {
    queueMicrotask(() => {
      const currentRows = rows();
      currentRows.slice(1).forEach((row) => row.remove());
      if (!currentRows[0]?.isConnected) list.append(template.content.cloneNode(true));
      const first = rows()[0];
      if (first) syncValueControl(first);
      syncRows();
    });
  });
  syncRows();
}

for (const form of document.querySelectorAll("[data-submission-form]")) {
  const memberRequired = form.hasAttribute("data-member-required");
  const image = form.querySelector('input[type="file"][name="image"]');
  const alt = form.querySelector('[name="image_alt"]');
  if (image && alt) {
    image.addEventListener("change", () => {
      alt.required = Boolean(image.files && image.files.length);
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(form);
    if (!form.checkValidity()) {
      form.__stcWizard?.showFirstInvalid();
      return;
    }
    if (memberRequired) setSubmissionSuccessLink(form, false);
    const submit = form.querySelector('button[type="submit"]');
    setButtonBusy(submit, true);
    const data = new FormData(form);
    for (const name of ["start_at", "end_at"]) {
      const value = data.get(name);
      if (typeof value === "string" && value) data.set(name, nassauLocalToIso(value));
    }
    try {
      await sessionPromise;
      if (memberRequired && !protectedSubmissionSessionReady()) {
        redirectProtectedSubmissionForm(form);
        return;
      }
      const headers = { "Idempotency-Key": crypto.randomUUID() };
      if (memberRequired) headers["X-CSRF-Token"] = memberState.csrfToken;
      else if (memberState.authenticated && memberState.csrfToken) headers["X-CSRF-Token"] = memberState.csrfToken;
      const request = {
        method: "POST",
        body: data,
        headers,
        ...(memberRequired ? { credentials: "same-origin", cache: "no-store" } : {}),
      };
      const response = await fetch(form.dataset.endpoint, request);
      const payload = objectValue(await response.json().catch(() => ({})));
      if (!response.ok) {
        showFieldErrors(form, payload.errors);
        const error = new Error(payload.message || "The form could not be submitted.");
        error.status = response.status;
        throw error;
      }
      showStatus(form, payload.message || "Your submission has been received for private review.", "success");
      form.reset();
      form.dispatchEvent(new Event("stc:submission-success"));
      if (alt) alt.required = false;
      if (memberRequired) setSubmissionSuccessLink(form, true);
    } catch (error) {
      if (memberRequired && (error?.status === 401 || error?.status === 403)) {
        redirectProtectedSubmissionForm(form);
        return;
      }
      showStatus(form, error instanceof Error ? error.message : "The form could not be submitted.", "error");
      resetTurnstile();
    } finally {
      setButtonBusy(submit, false);
    }
  });
}

for (const form of document.querySelectorAll("[data-newsletter-form]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(form);
    const submit = form.querySelector('button[type="submit"]');
    setButtonBusy(submit, true);
    const data = new FormData(form);
    const payload = {
      email: data.get("email"),
      hp: data.get("hp"),
      turnstile_token: data.get("cf-turnstile-response") || data.get("turnstile_token") || "",
    };
    try {
      const response = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        showFieldErrors(form, result.errors);
        throw new Error(result.message || "The subscription could not be saved.");
      }
      showStatus(form, result.message, "success");
      form.reset();
    } catch (error) {
      showStatus(form, error instanceof Error ? error.message : "The subscription could not be saved.", "error");
      resetTurnstile();
    } finally {
      setButtonBusy(submit, false);
    }
  });
}

let newsletterConfirmationToken = "";
const newsletterConfirmationRoot = document.querySelector("[data-newsletter-confirm]");
if (newsletterConfirmationRoot) {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    const candidate = new URLSearchParams(fragment).get("token") || "";
    if (/^[A-Za-z0-9_-]{32,200}$/.test(candidate)) newsletterConfirmationToken = candidate;
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  const button = newsletterConfirmationRoot.querySelector("[data-newsletter-confirm-continue]");
  const status = newsletterConfirmationRoot.querySelector("[data-newsletter-confirm-status]");
  if (button instanceof HTMLButtonElement) button.disabled = !newsletterConfirmationToken;
  if (!newsletterConfirmationToken && status) {
    status.textContent = "This confirmation link is invalid or incomplete. Request a new link from the home page.";
    status.className = "form-status error";
  } else if (status) {
    status.textContent = "Your private confirmation link is ready.";
    status.className = "form-status";
  }
  button?.addEventListener("click", async () => {
    if (!(button instanceof HTMLButtonElement) || !newsletterConfirmationToken) return;
    setButtonBusy(button, true);
    try {
      const response = await fetch("/api/newsletter/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ token: newsletterConfirmationToken }),
      });
      const payload = objectValue(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(payload.message || "The subscription could not be confirmed.");
      newsletterConfirmationToken = "";
      if (status) {
        status.textContent = payload.message || "Your community updates are confirmed.";
        status.className = "form-status success";
      }
      button.hidden = true;
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "The subscription could not be confirmed.";
        status.className = "form-status error";
      }
      setButtonBusy(button, false);
    }
  });
}

const unsubscribeButton = document.querySelector("[data-unsubscribe-token]");
if (unsubscribeButton) {
  unsubscribeButton.addEventListener("click", async () => {
    setButtonBusy(unsubscribeButton, true);
    const card = unsubscribeButton.closest(".member-action-card");
    try {
      const response = await fetch("/api/newsletter/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: unsubscribeButton.dataset.unsubscribeToken }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "The request could not be completed.");
      showStatus(card, payload.message, "success");
      unsubscribeButton.hidden = true;
    } catch (error) {
      showStatus(card, error instanceof Error ? error.message : "The request could not be completed.", "error");
      setButtonBusy(unsubscribeButton, false);
    }
  });
}

const MEMBER_SESSION_STATUS = Object.freeze({
  checking: "checking",
  authenticated: "authenticated",
  anonymous: "anonymous",
  recoverableFailure: "recoverable-failure",
  terminalFailure: "terminal-failure",
});

var memberState = {
  loaded: false,
  authenticated: false,
  status: MEMBER_SESSION_STATUS.checking,
  member: null,
  admin: null,
  csrfToken: "",
  dashboard: null,
};
let memberSessionGeneration = 0;
let memberViewGeneration = 0;
let dashboardRequestGeneration = 0;
const memberAuthChannel = typeof globalThis.BroadcastChannel === "function"
  ? new globalThis.BroadcastChannel("serve-the-cays-member-auth")
  : null;

// Strip a magic token from the address bar before this module makes any
// account request. The token stays only in this module closure until the
// member explicitly selects Continue.
let memberVerificationToken = "";
if (document.querySelector("[data-member-verify]")) {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    const params = new URLSearchParams(fragment);
    const candidate = params.get("token") || (/^[A-Za-z0-9_-]{32,256}$/.test(fragment) ? fragment : "");
    if (/^[A-Za-z0-9_-]{32,256}$/.test(candidate)) memberVerificationToken = candidate;
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

// Newsletter customization links carry only an opaque subscriber selector in
// the fragment. Remove it before making requests, and use it only to request a
// fresh short-lived sign-in email after the visitor deliberately continues.
let memberSubscriberToken = "";
if (document.querySelector("[data-member-signin-form]")) {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    const candidate = new URLSearchParams(fragment).get("subscriber") || "";
    if (/^[A-Za-z0-9_-]{32,256}$/.test(candidate)) memberSubscriberToken = candidate;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function apiMessage(payload, fallback) {
  if (payload && typeof payload.message === "string") return payload.message;
  if (payload && payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

async function apiRequest(path, options = {}, csrf = false) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (csrf && memberState.csrfToken) headers.set("X-CSRF-Token", memberState.csrfToken);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(apiMessage(payload, "The request could not be completed."));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function safeMemberPath(value, fallback = "/me") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n#]/.test(value)) return fallback;
  let parsed;
  try {
    parsed = new URL(value, window.location.origin);
  } catch {
    return fallback;
  }
  if (parsed.origin !== window.location.origin || parsed.username || parsed.password) return fallback;
  const path = parsed.pathname;
  const allowed = ["/", "/me", "/admin", "/organizations", "/events", "/about", "/privacy", "/suggest/organization", "/suggest/event"];
  if (allowed.includes(path) || path.startsWith("/organization/") || path.startsWith("/event/")) return `${parsed.pathname}${parsed.search}`;
  return fallback;
}

function currentNavigationSection(pathname = window.location.pathname) {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/organization")) return "organizations";
  if (pathname.startsWith("/event")) return "events";
  if (pathname.startsWith("/about")) return "about";
  if (pathname.startsWith("/signin") || pathname === "/signout" || pathname === "/me" || pathname.startsWith("/suggest/")) return "member";
  return "";
}

function syncCurrentNavigation() {
  const current = currentNavigationSection();
  for (const link of document.querySelectorAll("[data-nav-section]")) {
    if (link.dataset.navSection === current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function updateMemberNavigation() {
  const authenticated = memberState.status === MEMBER_SESSION_STATUS.authenticated;
  const anonymous = memberState.status === MEMBER_SESSION_STATUS.anonymous;
  const resolved = authenticated || anonymous;
  for (const link of document.querySelectorAll("[data-member-nav]")) {
    const label = link.querySelector("[data-member-nav-label]");
    const status = link.querySelector("[data-member-nav-status]");
    const unavailable = memberState.status === MEMBER_SESSION_STATUS.recoverableFailure || memberState.status === MEMBER_SESSION_STATUS.terminalFailure;
    const loadingText = unavailable ? "Sign-in status unavailable" : "Checking sign-in status";
    if (label) {
      label.textContent = authenticated ? "My STC" : anonymous ? "Sign in" : "";
    }
    if (status instanceof HTMLElement) {
      status.textContent = resolved ? "" : loadingText;
      status.hidden = resolved;
    }
    link.setAttribute("href", authenticated ? "/me" : "/signin");
    link.dataset.memberState = memberState.status;
    link.hidden = !resolved;
    if (resolved) {
      link.removeAttribute("aria-busy");
      link.removeAttribute("aria-label");
    } else {
      link.setAttribute("aria-busy", "true");
      link.setAttribute("aria-label", loadingText);
    }
  }
  syncCurrentNavigation();
}

function memberSessionFailed() {
  return memberState.status === MEMBER_SESSION_STATUS.recoverableFailure || memberState.status === MEMBER_SESSION_STATUS.terminalFailure;
}

function memberSessionFailureStatus(error) {
  const status = Number(error && error.status);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500
    ? MEMBER_SESSION_STATUS.recoverableFailure
    : MEMBER_SESSION_STATUS.terminalFailure;
}

function setMemberSessionStatus(status, message = "") {
  memberState.status = status;
  const dashboard = document.querySelector("[data-member-dashboard]");
  const protectedContent = dashboard?.querySelector("[data-member-protected]");
  const loading = dashboard?.querySelector("[data-member-session-loading]");
  const spinner = loading?.querySelector("[data-member-session-spinner]");
  const heading = loading?.querySelector("h1");
  const copy = loading?.querySelector("p");
  const retry = loading?.querySelector("[data-member-session-retry]");
  const authenticated = status === MEMBER_SESSION_STATUS.authenticated;
  const anonymous = status === MEMBER_SESSION_STATUS.anonymous;
  const checking = status === MEMBER_SESSION_STATUS.checking;
  const recoverableFailure = status === MEMBER_SESSION_STATUS.recoverableFailure;
  const failed = recoverableFailure || status === MEMBER_SESSION_STATUS.terminalFailure;
  if (protectedContent instanceof HTMLElement) {
    protectedContent.hidden = !authenticated;
    if (authenticated) protectedContent.removeAttribute("inert");
    else protectedContent.setAttribute("inert", "");
  }
  if (loading instanceof HTMLElement) loading.hidden = authenticated || anonymous;
  if (spinner instanceof HTMLElement) spinner.hidden = !checking;
  if (retry instanceof HTMLButtonElement) retry.hidden = !recoverableFailure;
  if (checking) {
    if (heading) heading.textContent = "Checking your session…";
    if (copy) copy.textContent = "We’re securely confirming your My STC account.";
  } else if (failed) {
    if (heading) heading.textContent = recoverableFailure ? "Session check unavailable" : "Session check failed";
    if (copy) copy.textContent = message || (recoverableFailure ? "We couldn’t confirm your session. Please try again." : "This session could not be confirmed. Request a new sign-in link to continue.");
  }
  if (dashboard) dashboard.setAttribute("aria-busy", String(checking));
  updateMemberNavigation();
}

function showMemberSessionFailure(error) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  setMemberSessionStatus(memberSessionFailureStatus(error), message);
}

function clearMemberPrivateView() {
  memberSessionGeneration += 1;
  memberViewGeneration += 1;
  dashboardRequestGeneration += 1;
  memberState.loaded = true;
  memberState.authenticated = false;
  memberState.member = null;
  memberState.admin = null;
  memberState.csrfToken = "";
  memberState.dashboard = null;
  dashboardPromise = null;
  setMemberSessionStatus(MEMBER_SESSION_STATUS.anonymous);
}

async function loadMemberSession() {
  const generation = ++memberSessionGeneration;
  memberState.loaded = false;
  setMemberSessionStatus(MEMBER_SESSION_STATUS.checking);
  try {
    const payload = await apiRequest("/api/member/session", { method: "GET" });
    if (generation !== memberSessionGeneration) return memberState;
    const session = objectValue(payload.session);
    const member = objectValue(payload.member || session.member);
    const admin = objectValue(payload.admin || session.admin);
    memberState.authenticated = payload.authenticated === true || Boolean(member.id || member.email || session.member_id);
    memberState.member = memberState.authenticated ? member : null;
    memberState.admin = memberState.authenticated && admin.authorized === true ? admin : null;
    memberState.csrfToken = String(payload.csrf_token || session.csrf_token || "");
    setMemberSessionStatus(memberState.authenticated && document.querySelector("[data-member-dashboard]")
      ? MEMBER_SESSION_STATUS.checking
      : memberState.authenticated
        ? MEMBER_SESSION_STATUS.authenticated
        : MEMBER_SESSION_STATUS.anonymous);
  } catch (error) {
    if (generation !== memberSessionGeneration) return memberState;
    if (error && error.status === 401) {
      memberState.authenticated = false;
      memberState.member = null;
      memberState.admin = null;
      memberState.csrfToken = "";
      setMemberSessionStatus(MEMBER_SESSION_STATUS.anonymous);
    } else {
      showMemberSessionFailure(error);
    }
  } finally {
    if (generation === memberSessionGeneration) {
      memberState.loaded = true;
      updateMemberNavigation();
    }
  }
  return memberState;
}

updateMemberNavigation();
var sessionPromise = loadMemberSession();
let dashboardPromise = null;

void initializeProtectedSubmissionForms();

function dashboardCollections(dashboard) {
  const favorites = objectValue(dashboard.favorites);
  const rsvps = objectValue(dashboard.rsvps);
  return {
    organizations: arrayValue(dashboard.favorite_organizations || dashboard.saved_organizations || favorites.organizations),
    events: arrayValue(dashboard.favorite_events || dashboard.saved_events || favorites.events),
    upcomingRsvps: arrayValue(dashboard.upcoming_rsvps || rsvps.upcoming),
    pastRsvps: arrayValue(dashboard.past_rsvps || dashboard.rsvp_history || rsvps.past),
    submissions: arrayValue(dashboard.submissions || dashboard.submitted_suggestions),
  };
}

function nestedEntity(item, kind) {
  const record = objectValue(item);
  const nested = objectValue(record[kind]);
  return Object.keys(nested).length ? nested : record;
}

function entityId(item, kind) {
  if (typeof item === "string" || typeof item === "number") return String(item);
  const record = objectValue(item);
  const entity = nestedEntity(record, kind);
  return String(entity.id || record[`${kind}_id`] || "");
}

async function loadMemberDashboard(force = false) {
  if (!memberState.authenticated) return null;
  if (force) {
    dashboardRequestGeneration += 1;
    dashboardPromise = null;
  }
  if (!dashboardPromise) {
    const generation = ++dashboardRequestGeneration;
    dashboardPromise = apiRequest("/api/member/dashboard", { method: "GET" })
      .then((payload) => {
        if (generation !== dashboardRequestGeneration || !memberState.authenticated) return null;
        if (payload.csrf_token) memberState.csrfToken = String(payload.csrf_token);
        memberState.dashboard = objectValue(payload.dashboard && typeof payload.dashboard === "object" ? payload.dashboard : payload);
        const member = objectValue(memberState.dashboard.member);
        if (Object.keys(member).length) memberState.member = member;
        applyMemberItemState(memberState.dashboard);
        return memberState.dashboard;
      })
      .catch((error) => {
        if (generation === dashboardRequestGeneration) dashboardPromise = null;
        throw error;
      });
  }
  return dashboardPromise;
}

function setFavoriteButton(button, saved) {
  button.setAttribute("aria-pressed", String(saved));
  button.classList.toggle("is-saved", saved);
  const label = button.querySelector(".member-action-label");
  if (label) label.textContent = saved ? "Saved" : "Save";
  const noun = button.dataset.favoriteType === "organization" ? "organization" : "event";
  button.setAttribute("aria-label", saved ? `Remove this ${noun} from My STC` : `Save this ${noun}`);
}

const favoriteAnimationTimers = new WeakMap();
const favoriteMutationKeys = new Set();

function animateFavoriteButton(button, saved) {
  const previousTimer = favoriteAnimationTimers.get(button);
  if (previousTimer) window.clearTimeout(previousTimer);
  favoriteAnimationTimers.delete(button);
  button.classList.remove("is-heart-beating", "is-heart-breaking");
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  void button.offsetWidth;
  const animationClass = saved ? "is-heart-beating" : "is-heart-breaking";
  button.classList.add(animationClass);
  const duration = saved ? 760 : 860;
  const timer = window.setTimeout(() => {
    button.classList.remove(animationClass);
    favoriteAnimationTimers.delete(button);
  }, duration);
  favoriteAnimationTimers.set(button, timer);
  return duration;
}

function favoriteButtonsFor(kind, id) {
  return [...document.querySelectorAll(`.member-favorite[data-favorite-type="${kind}"][data-favorite-id="${CSS.escape(id)}"]`)]
    .filter((button) => button instanceof HTMLButtonElement);
}

function setFavoriteMutationPending(buttons, pending) {
  for (const button of buttons) {
    button.disabled = pending;
    if (pending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
}

function createPixelHeart() {
  const wrapper = document.createElement("span");
  wrapper.className = "member-pixel-heart";
  wrapper.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("member-pixel-heart-svg");
  svg.setAttribute("viewBox", "0 0 7 6");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("shape-rendering", "crispEdges");
  const heartPath = "M1 0H3V1H4V0H6V1H7V3H6V4H5V5H4V6H3V5H2V4H1V3H0V1H1Z";
  for (const [className, pathData] of [
    ["member-pixel-heart-outline", heartPath],
    ["member-pixel-heart-fill", heartPath],
    ["member-pixel-heart-crack", "M3 0H4V2H3V3H4V4H3V6H2V4H3V3H2V2H3Z"],
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add(className);
    path.setAttribute("d", pathData);
    svg.append(path);
  }

  const bitOne = document.createElement("span");
  bitOne.className = "member-pixel-heart-bit member-pixel-heart-bit-one";
  const bitTwo = document.createElement("span");
  bitTwo.className = "member-pixel-heart-bit member-pixel-heart-bit-two";
  wrapper.append(svg, bitOne, bitTwo);
  return wrapper;
}

function setRsvpButton(button, going) {
  if (!memberState.authenticated) {
    button.removeAttribute("aria-pressed");
    delete button.dataset.rsvpState;
    button.classList.remove("is-going");
    button.textContent = "Sign in to say you’re going";
    return;
  }
  button.setAttribute("aria-pressed", String(going));
  button.dataset.rsvpState = going ? "going" : "cancelled";
  button.classList.toggle("is-going", going);
  button.textContent = going ? "Cancel RSVP" : "I’m Going";
}

function setRsvpCount(eventId, value) {
  const nextCount = Math.max(0, Number(value) || 0);
  for (const count of document.querySelectorAll(`[data-rsvp-count="${CSS.escape(String(eventId))}"]`)) {
    count.textContent = String(nextCount);
  }
  for (const label of document.querySelectorAll(`[data-rsvp-count-label="${CSS.escape(String(eventId))}"]`)) {
    label.textContent = nextCount === 1 ? "person is" : "people are";
  }
}

function applyMemberItemState(dashboard) {
  const collections = dashboardCollections(objectValue(dashboard));
  const organizationIds = new Set(collections.organizations.map((item) => entityId(item, "organization")).filter(Boolean));
  const eventIds = new Set(collections.events.map((item) => entityId(item, "event")).filter(Boolean));
  const rsvpIds = new Set(collections.upcomingRsvps
    .filter((item) => objectValue(item).status !== "cancelled")
    .map((item) => entityId(item, "event"))
    .filter(Boolean));
  for (const button of document.querySelectorAll(".member-favorite")) {
    const ids = button.dataset.favoriteType === "organization" ? organizationIds : eventIds;
    setFavoriteButton(button, ids.has(String(button.dataset.favoriteId || "")));
  }
  for (const button of document.querySelectorAll("[data-rsvp-event-id]")) {
    setRsvpButton(button, rsvpIds.has(String(button.dataset.rsvpEventId || "")));
  }
}

function signInForAction(intent, target) {
  const params = new URLSearchParams({
    return: safeMemberPath(`${window.location.pathname}${window.location.search}`, "/me"),
    intent,
    target: String(target),
  });
  window.location.assign(`/signin?${params.toString()}`);
}

function actionStatusFor(element) {
  return element.closest("[data-event-member-actions]")?.querySelector(".member-action-status")
    || document.querySelector("[data-member-dashboard-status]")
    || document.querySelector("[data-member-global-status]");
}

const memberActionStatusTimers = new WeakMap();

function clearMemberActionStatusDismissal(status) {
  const timers = memberActionStatusTimers.get(status);
  if (timers) {
    window.clearTimeout(timers.fadeTimer);
    window.clearTimeout(timers.hideTimer);
  }
  memberActionStatusTimers.delete(status);
  status.classList.remove("is-dismissing");
}

function showMemberActionStatus(element, message, error = false, dismissAfter = 0) {
  const status = actionStatusFor(element);
  if (!status) return;
  clearMemberActionStatusDismissal(status);
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.toggle("success", !error);
  status.hidden = false;
  if (!error && dismissAfter > 0) {
    const fadeTimer = window.setTimeout(() => {
      status.classList.add("is-dismissing");
    }, dismissAfter);
    const hideTimer = window.setTimeout(() => {
      status.hidden = true;
      status.textContent = "";
      status.classList.remove("is-dismissing", "success");
      memberActionStatusTimers.delete(status);
    }, dismissAfter + 260);
    memberActionStatusTimers.set(status, { fadeTimer, hideTimer });
  }
}

document.addEventListener("click", async (event) => {
  const clicked = event.target instanceof Element ? event.target : null;
  const favorite = clicked?.closest(".member-favorite");
  if (favorite instanceof HTMLButtonElement) {
    event.preventDefault();
    const kind = favorite.dataset.favoriteType === "organization" ? "organization" : "event";
    const id = String(favorite.dataset.favoriteId || "");
    if (!id) return;
    const mutationKey = `${kind}:${id}`;
    if (favorite.disabled || favoriteMutationKeys.has(mutationKey)) return;
    favoriteMutationKeys.add(mutationKey);
    const matchingButtons = favoriteButtonsFor(kind, id);
    setFavoriteMutationPending(matchingButtons, true);
    await sessionPromise;
    if (!memberState.authenticated) {
      setFavoriteMutationPending(matchingButtons, false);
      favoriteMutationKeys.delete(mutationKey);
      signInForAction(kind === "organization" ? "favorite_organization" : "favorite_event", id);
      return;
    }
    const wasSaved = favorite.getAttribute("aria-pressed") === "true";
    const dashboardList = favorite.closest(".member-dashboard-list");
    const restoreDashboardFocus = document.activeElement === favorite;
    const pendingLabel = favorite.querySelector(".member-action-label");
    if (pendingLabel) pendingLabel.textContent = wasSaved ? "Removing…" : "Saving…";
    try {
      await apiRequest(`/api/member/favorites/${kind === "organization" ? "organizations" : "events"}/${encodeURIComponent(id)}`, {
        method: wasSaved ? "DELETE" : "PUT",
      }, true);
      for (const match of favoriteButtonsFor(kind, id)) {
        setFavoriteButton(match, !wasSaved);
      }
      const animationDuration = animateFavoriteButton(favorite, !wasSaved);
      memberState.dashboard = null;
      dashboardPromise = null;
      showMemberActionStatus(
        favorite,
        wasSaved ? "Removed from My STC." : "Saved to My STC.",
        false,
        wasSaved ? 3000 : 0,
      );
      if (favorite.closest("[data-member-dashboard]")) {
        const refreshPromise = loadMemberDashboard(true);
        if (wasSaved && animationDuration > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, animationDuration));
        }
        const refreshed = await refreshPromise;
        if (refreshed) renderMemberDashboard(refreshed);
        if (restoreDashboardFocus && dashboardList instanceof HTMLElement) {
          const nextFavorite = dashboardList.querySelector(".member-favorite");
          const panelHeading = dashboardList.closest(".member-panel")?.querySelector("h2");
          if (nextFavorite instanceof HTMLButtonElement) nextFavorite.focus();
          else if (panelHeading instanceof HTMLElement) {
            panelHeading.setAttribute("tabindex", "-1");
            panelHeading.focus();
            panelHeading.addEventListener("blur", () => panelHeading.removeAttribute("tabindex"), { once: true });
          }
        }
      }
    } catch (error) {
      showMemberActionStatus(favorite, error instanceof Error ? error.message : "That item could not be updated.", true);
    } finally {
      const currentButtons = new Set([...matchingButtons, ...favoriteButtonsFor(kind, id)]);
      setFavoriteMutationPending(currentButtons, false);
      for (const button of currentButtons) {
        setFavoriteButton(button, button.getAttribute("aria-pressed") === "true");
      }
      favoriteMutationKeys.delete(mutationKey);
    }
    return;
  }

  const rsvp = clicked?.closest("[data-rsvp-event-id]");
  if (rsvp instanceof HTMLButtonElement) {
    event.preventDefault();
    await sessionPromise;
    const id = String(rsvp.dataset.rsvpEventId || "");
    if (!id) return;
    if (!memberState.authenticated) {
      signInForAction("rsvp_event", id);
      return;
    }
    const wasGoing = rsvp.getAttribute("aria-pressed") === "true";
    rsvp.disabled = true;
    rsvp.setAttribute("aria-busy", "true");
    rsvp.textContent = wasGoing ? "Cancelling…" : "Updating…";
    try {
      const payload = await apiRequest(`/api/member/events/${encodeURIComponent(id)}/rsvp`, {
        method: wasGoing ? "DELETE" : "PUT",
      }, true);
      setRsvpButton(rsvp, !wasGoing);
      const returnedCount = Number(payload.rsvp_count ?? objectValue(payload.rsvp).rsvp_count);
      for (const count of document.querySelectorAll(`[data-rsvp-count="${CSS.escape(id)}"]`)) {
        const current = Number(count.textContent || "0");
        const nextCount = Number.isFinite(returnedCount) ? returnedCount : Math.max(0, current + (wasGoing ? -1 : 1));
        setRsvpCount(id, nextCount);
      }
      memberState.dashboard = null;
      dashboardPromise = null;
      showMemberActionStatus(rsvp, wasGoing ? "Your RSVP was cancelled." : "You’re going. A confirmation has been prepared for you.");
    } catch (error) {
      showMemberActionStatus(rsvp, error instanceof Error ? error.message : "Your RSVP could not be updated.", true);
    } finally {
      rsvp.disabled = false;
      rsvp.removeAttribute("aria-busy");
      setRsvpButton(rsvp, rsvp.getAttribute("aria-pressed") === "true");
    }
  }
});

function setupMemberSignin() {
  const form = document.querySelector("[data-member-signin-form]");
  if (!(form instanceof HTMLFormElement)) return;
  const reset = form.querySelector("[data-member-signin-reset]");
  const email = form.elements.namedItem("email");
  const emailGroup = email instanceof HTMLInputElement ? email.closest(".form-group") : null;
  const intro = document.querySelector("[data-member-signin-intro]");
  const submit = form.querySelector('button[type="submit"]');

  if (memberSubscriberToken) {
    if (email instanceof HTMLInputElement) {
      email.required = false;
      email.disabled = true;
      email.value = "";
    }
    if (emailGroup instanceof HTMLElement) emailGroup.hidden = true;
    if (intro) intro.textContent = "Request a fresh, one-time sign-in link at the private address receiving your STC updates. We won’t display the address here.";
    if (submit) submit.textContent = "Email me a secure sign-in link";
    if (reset) reset.hidden = false;
  }

  reset?.addEventListener("click", () => {
    const preview = form.querySelector("[data-development-signin]");
    clearErrors(form);
    form.classList.remove("member-auth-form-sent");
    memberSubscriberToken = "";
    if (email instanceof HTMLInputElement) {
      email.disabled = false;
      email.required = true;
      email.readOnly = false;
      email.value = "";
      email.focus();
    }
    if (emailGroup instanceof HTMLElement) emailGroup.hidden = false;
    if (intro) intro.textContent = intro.dataset.defaultMessage || "We’ll email you a secure, one-time sign-in link. No password needed.";
    if (submit) submit.textContent = "Email me a sign-in link";
    if (preview) preview.hidden = true;
    reset.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(form);
    setButtonBusy(submit, true);
    const data = new FormData(form);
    const payload = {
      email: memberSubscriberToken ? "" : data.get("email"),
      subscriber_token: memberSubscriberToken,
      return_path: safeMemberPath(String(data.get("return_path") || "/me")),
      intent_type: String(data.get("intent_type") || ""),
      target_id: String(data.get("target_id") || ""),
      turnstile_token: data.get("cf-turnstile-response") || data.get("turnstile_token") || "",
    };
    try {
      const result = await apiRequest("/api/member/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      showStatus(form, apiMessage(result, "If that address can receive mail, a sign-in link is on its way."), "success");
      form.classList.add("member-auth-form-sent");
      const emailField = form.elements.namedItem("email");
      if (emailField instanceof HTMLInputElement) emailField.readOnly = true;
      if (submit) submit.textContent = "Resend sign-in link";
      if (reset) reset.hidden = false;
      const developmentUrl = result.development_sign_in_url || result.development_signin_url || result.preview_url;
      const preview = form.querySelector("[data-development-signin]");
      if (preview && typeof developmentUrl === "string") {
        try {
          const linkUrl = new URL(developmentUrl, window.location.origin);
          if (linkUrl.origin === window.location.origin && linkUrl.pathname === "/signin/verify") {
            preview.replaceChildren();
            const note = document.createElement("p");
            note.textContent = "Local mode captured this message. ";
            const link = document.createElement("a");
            link.href = linkUrl.href;
            link.textContent = "Open the development sign-in link";
            note.append(link, ".");
            const inbox = document.createElement("a");
            inbox.href = "/dev/inbox";
            inbox.textContent = "View the local email inbox";
            preview.append(note, inbox);
            preview.hidden = false;
          }
        } catch {
          preview.hidden = true;
        }
      }
    } catch (error) {
      showStatus(form, error instanceof Error ? error.message : "A sign-in link could not be requested.", "error");
      resetTurnstile();
    } finally {
      setButtonBusy(submit, false);
    }
  });
}

function setupMemberVerification() {
  const card = document.querySelector("[data-member-verify]");
  const button = card?.querySelector("[data-member-verify-continue]");
  const status = card?.querySelector("[data-member-verify-status]");
  if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;

  if (!memberVerificationToken) {
    status.textContent = "This sign-in link is missing or invalid. Request a new one to continue.";
    status.className = "form-status error";
    status.hidden = false;
    return;
  }
  button.disabled = false;
  button.addEventListener("click", async () => {
    setButtonBusy(button, true);
    status.hidden = true;
    try {
      const payload = await apiRequest("/api/member/auth/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: memberVerificationToken }),
      });
      memberVerificationToken = "";
      status.textContent = "Email confirmed. Opening My STC…";
      status.className = "form-status success";
      status.hidden = false;
      const destination = safeMemberPath(String(payload.redirect_to || payload.return_path || "/me"));
      window.location.replace(destination);
    } catch (error) {
      memberVerificationToken = "";
      status.textContent = error instanceof Error ? error.message : "This link could not be used. Request a new sign-in link.";
      status.className = "form-status error";
      status.hidden = false;
    }
  });
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textElement(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  return node;
}

function readableDate(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-BS", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Nassau",
  }).format(date);
}

function entityLink(kind, entity) {
  const id = String(entity.id || "");
  if (kind === "organization") return `/organization/${encodeURIComponent(String(entity.slug || id))}`;
  return `/event/${encodeURIComponent(id)}`;
}

function renderEmpty(container, message) {
  clearNode(container);
  container.append(textElement("p", "member-empty", message));
}

function renderEntityList(container, items, kind, emptyMessage, options = {}) {
  if (!container) return;
  clearNode(container);
  if (!items.length) {
    container.append(textElement("p", "member-empty", emptyMessage));
    return;
  }
  for (const item of items) {
    const record = objectValue(item);
    const entity = nestedEntity(record, kind);
    const row = document.createElement("article");
    row.className = "member-dashboard-item";
    const copy = document.createElement("div");
    const link = document.createElement("a");
    link.href = entityLink(kind, entity);
    link.textContent = String(entity.name || (kind === "organization" ? "Organization" : "Event"));
    link.className = "member-dashboard-item-title";
    copy.append(link);
    if (kind === "event") {
      copy.append(textElement("span", "member-dashboard-item-meta", readableDate(entity.start_at)));
      const venue = [entity.venue_name, entity.location_display].filter(Boolean).join(" · ");
      if (venue) copy.append(textElement("span", "member-dashboard-item-meta", venue));
    }
    if (options.showStatus) {
      copy.append(textElement("span", "member-dashboard-item-meta", String(record.status || "going")));
    }
    row.append(copy);
    if (options.favorite) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "member-favorite member-favorite-inline is-saved";
      button.dataset.favoriteType = kind;
      button.dataset.favoriteId = entityId(item, kind);
      button.setAttribute("aria-pressed", "true");
      button.setAttribute("aria-label", `Remove this ${kind} from My STC`);
      const label = textElement("span", "member-action-label", "Saved");
      button.append(createPixelHeart(), label);
      row.append(button);
    }
    container.append(row);
  }
}

function renderSubmissionList(container, items) {
  if (!container) return;
  clearNode(container);
  if (!items.length) {
    container.append(textElement("p", "member-empty", "Suggestions you submit while signed in will appear here."));
    return;
  }
  for (const item of items) {
    const record = objectValue(item);
    const row = document.createElement("article");
    row.className = "member-dashboard-item";
    const copy = document.createElement("div");
    copy.append(textElement("strong", "member-dashboard-item-title", record.name || "Suggestion"));
    const type = String(record.type || record.submission_type || "suggestion");
    const created = record.created_at ? ` · ${readableDate(record.created_at)}` : "";
    copy.append(textElement("span", "member-dashboard-item-meta", `${type} · ${record.status || "pending"}${created}`));
    row.append(copy);
    container.append(row);
  }
}

function legacyFavoriteNames() {
  try {
    const parsed = JSON.parse(localStorage.getItem("stc_favorites") || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 200);
  } catch {
    return [];
  }
}

function setupLegacyImport(member) {
  const card = document.querySelector("[data-legacy-import]");
  const button = card?.querySelector("[data-legacy-import-button]");
  if (!(card instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return;
  const names = legacyFavoriteNames();
  if (!names.length || member.legacy_favorites_imported_at) {
    card.hidden = true;
    return;
  }
  const description = card.querySelector("p");
  if (description) description.textContent = `${names.length} browser-only ${names.length === 1 ? "favorite was" : "favorites were"} found. Import unambiguous name matches to make them available across devices.`;
  card.hidden = false;
  button.addEventListener("click", async () => {
    if (!window.confirm(`Import ${names.length} saved organization ${names.length === 1 ? "name" : "names"} into this account?`)) return;
    button.disabled = true;
    try {
      const payload = await apiRequest("/api/member/favorites/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      }, true);
      const unresolved = Number(payload.unmatched_count || 0) + Number(payload.ambiguous_count || 0);
      if (!unresolved) {
        localStorage.removeItem("stc_favorites");
        card.hidden = true;
      } else {
        const unresolvedNames = [
          ...arrayValue(payload.unmatched_names),
          ...arrayValue(payload.ambiguous_names),
        ].filter((value) => typeof value === "string");
        if (unresolvedNames.length) localStorage.setItem("stc_favorites", JSON.stringify(unresolvedNames));
      }
      const status = document.querySelector("[data-member-dashboard-status]");
      if (status) {
        const importedValue = payload.imported_count ?? payload.imported ?? 0;
        const imported = Array.isArray(importedValue) ? importedValue.length : Number(importedValue);
        status.textContent = imported ? `${imported} saved ${imported === 1 ? "organization was" : "organizations were"} imported.` : "Legacy favorites were reviewed. No unambiguous new matches were found.";
        status.className = "form-status success";
        status.hidden = false;
      }
      const refreshed = await loadMemberDashboard(true);
      if (refreshed) renderMemberDashboard(refreshed);
    } catch (error) {
      const status = document.querySelector("[data-member-dashboard-status]");
      if (status) {
        status.textContent = error instanceof Error ? error.message : "Legacy favorites could not be imported.";
        status.className = "form-status error";
        status.hidden = false;
      }
      button.disabled = false;
    }
  }, { once: true });
}

function renderMemberDashboard(dashboard, generation = memberViewGeneration) {
  if (generation !== memberViewGeneration || !memberState.authenticated || memberSessionFailed()) return;
  const dashboardRoot = document.querySelector("[data-member-dashboard]");
  const member = objectValue(dashboard.member || memberState.member);
  memberState.member = member;
  const collections = dashboardCollections(dashboard);
  const welcome = document.querySelector("[data-member-welcome]");
  if (welcome) welcome.textContent = member.display_name ? `Welcome back, ${member.display_name}.` : "Your saved organizations, events, and RSVPs live here.";
  const profile = document.querySelector("[data-member-profile-form]");
  if (profile instanceof HTMLFormElement) {
    const email = profile.elements.namedItem("email");
    const displayName = profile.elements.namedItem("display_name");
    const reminders = profile.elements.namedItem("event_reminders_enabled");
    const settings = objectValue(dashboard.notification_settings);
    if (email instanceof HTMLInputElement) email.value = String(member.email || "");
    if (displayName instanceof HTMLInputElement) displayName.value = String(member.display_name || "");
    if (reminders instanceof HTMLInputElement) reminders.checked = member.reminder_emails_enabled === true || member.reminder_emails_enabled === 1 || member.event_reminders_enabled === true || member.event_reminders_enabled === 1 || settings.event_reminders_enabled === true;
    renderMemberNewsletterPreferences(profile, settings);
    renderMemberNotificationFilters(profile, settings, objectValue(dashboard.notification_taxonomy));
    const submit = profile.querySelector("[data-member-profile-submit]");
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
  }
  renderEntityList(document.querySelector("[data-saved-organizations]"), collections.organizations, "organization", "You haven’t saved any organizations yet.", { favorite: true });
  renderEntityList(document.querySelector("[data-saved-events]"), collections.events, "event", "You haven’t saved any events yet.", { favorite: true });
  renderEntityList(document.querySelector("[data-upcoming-rsvps]"), collections.upcomingRsvps, "event", "You don’t have any upcoming RSVPs.", { showStatus: true });
  renderEntityList(document.querySelector("[data-past-rsvps]"), collections.pastRsvps, "event", "Past RSVP history will appear here.", { showStatus: true });
  renderSubmissionList(document.querySelector("[data-member-submissions]"), collections.submissions);
  setupLegacyImport(member);
  applyMemberItemState(dashboard);
  dashboardRoot?.setAttribute("aria-busy", "false");
  setMemberSessionStatus(MEMBER_SESSION_STATUS.authenticated);
}

function renderMemberNotificationOptions(root, optionsValue, selectedValue, fieldName, labelFor) {
  if (!(root instanceof HTMLElement)) return;
  const options = arrayValue(optionsValue).map(objectValue);
  const selected = new Set(arrayValue(selectedValue).map((value) => String(value)));
  root.replaceChildren();
  if (!options.length) {
    const empty = document.createElement("p");
    empty.className = "member-fine-print";
    empty.textContent = "No choices are available right now.";
    root.append(empty);
    return;
  }
  options.forEach((option, index) => {
    const id = String(option.id || "");
    const labelText = labelFor(option);
    if (!id || !labelText) return;
    const label = document.createElement("label");
    label.className = "member-notification-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = fieldName;
    input.value = id;
    input.id = `${fieldName}-${index + 1}`;
    input.checked = selected.has(id);
    input.autocomplete = "off";
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(input, text);
    root.append(label);
  });
}

function renderMemberNotificationFilters(profile, settingsValue, taxonomyValue) {
  const settings = objectValue(settingsValue);
  const taxonomy = objectValue(taxonomyValue);
  renderMemberNotificationOptions(
    profile.querySelector("[data-member-notification-categories]"),
    taxonomy.categories,
    settings.event_category_ids,
    "event_category_ids",
    (category) => String(category.name || ""),
  );
  renderMemberNotificationOptions(
    profile.querySelector("[data-member-notification-locations]"),
    taxonomy.locations,
    settings.event_location_ids,
    "event_location_ids",
    (location) => [location.city, location.island].map((value) => String(value || "").trim()).filter(Boolean).join(", "),
  );
}

function renderMemberNewsletterPreferences(profile, settingsValue) {
  const settings = objectValue(settingsValue);
  const personalized = profile.elements.namedItem("personalized_updates_enabled");
  const status = profile.querySelector("[data-member-newsletter-status]");
  const active = settings.newsletter_subscribed === true;
  const newsletterStatus = String(settings.newsletter_status || (active ? "active" : "not_subscribed"));
  const categoryCount = arrayValue(settings.event_category_ids).length;
  const locationCount = arrayValue(settings.event_location_ids).length;
  if (personalized instanceof HTMLInputElement) {
    personalized.disabled = !active;
    personalized.checked = active && settings.personalized_updates_enabled === true;
    personalized.dataset.newsletterActive = String(active);
  }
  if (!status) return;
  if (active && settings.personalized_updates_enabled === true && (categoryCount || locationCount)) {
    const interestCopy = categoryCount ? `${categoryCount} selected interest${categoryCount === 1 ? "" : "s"}` : "all interests";
    const locationCopy = locationCount ? `${locationCount} selected place${locationCount === 1 ? "" : "s"}` : "all places";
    status.textContent = `Your community updates use ${interestCopy}, ${locationCopy}, and organizations you save.`;
  } else if (active && settings.personalized_updates_enabled === true) {
    status.textContent = "Your community updates cover all interests and places, with priority given to organizations you save.";
  } else if (active) {
    status.textContent = "You receive general community updates. Turn on personalization to use saved organizations plus your selected interests and places.";
  } else if (newsletterStatus === "unsubscribed") {
    status.textContent = "Community updates are unsubscribed. Signing in does not reactivate newsletter consent.";
  } else {
    status.textContent = "This account is not subscribed to community updates. Signing in never subscribes you automatically.";
  }
}

async function resolveMemberDashboard(session = sessionPromise, forceDashboard = false) {
  const generation = ++memberViewGeneration;
  setMemberSessionStatus(MEMBER_SESSION_STATUS.checking);
  await session;
  if (generation !== memberViewGeneration) return;
  if (memberState.status === MEMBER_SESSION_STATUS.anonymous) {
    window.location.replace("/signin?return=%2Fme");
    return;
  }
  if (memberSessionFailed()) return;
  if (!memberState.authenticated) {
    setMemberSessionStatus(MEMBER_SESSION_STATUS.terminalFailure, "This session could not be confirmed. Request a new sign-in link to continue.");
    return;
  }
  try {
    const dashboard = await loadMemberDashboard(forceDashboard);
    if (generation !== memberViewGeneration) return;
    if (dashboard) renderMemberDashboard(dashboard, generation);
    else showMemberSessionFailure("Your dashboard could not be loaded.");
  } catch (error) {
    if (generation !== memberViewGeneration) return;
    if (error && error.status === 401) {
      clearMemberPrivateView();
      window.location.replace("/signin?return=%2Fme");
      return;
    }
    showMemberSessionFailure(error);
  }
}

function setupMemberDashboard() {
  const dashboardElement = document.querySelector("[data-member-dashboard]");
  if (!dashboardElement) return;
  void resolveMemberDashboard(sessionPromise);

  const sessionRetry = dashboardElement.querySelector("[data-member-session-retry]");
  sessionRetry?.addEventListener("click", () => {
    if (!(sessionRetry instanceof HTMLButtonElement)) return;
    sessionPromise = loadMemberSession();
    void resolveMemberDashboard(sessionPromise, true);
  });

  const profile = document.querySelector("[data-member-profile-form]");
  if (profile instanceof HTMLFormElement) {
    profile.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = profile.querySelector('button[type="submit"]');
      const profileStatus = profile.querySelector("[data-member-profile-status]");
      const data = new FormData(profile);
      const personalized = profile.elements.namedItem("personalized_updates_enabled");
      const update = {
        display_name: String(data.get("display_name") || "").trim(),
        reminder_emails_enabled: data.get("event_reminders_enabled") === "on",
        event_category_ids: data.getAll("event_category_ids").map((value) => String(value)),
        event_location_ids: data.getAll("event_location_ids").map((value) => String(value)),
      };
      if (personalized instanceof HTMLInputElement && personalized.dataset.newsletterActive === "true") {
        update.personalized_updates_enabled = personalized.checked;
      }
      setButtonBusy(submit, true);
      try {
        const payload = await apiRequest("/api/member/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        }, true);
        const member = objectValue(payload.member);
        if (Object.keys(member).length) memberState.member = member;
        if (payload.notification_settings) renderMemberNewsletterPreferences(profile, payload.notification_settings);
        if (payload.csrf_token) memberState.csrfToken = String(payload.csrf_token);
        if (profileStatus) {
          profileStatus.textContent = "Profile and notification settings saved.";
          profileStatus.className = "member-inline-status success";
        }
      } catch (error) {
        if (profileStatus) {
          profileStatus.textContent = error instanceof Error ? error.message : "Your profile could not be saved.";
          profileStatus.className = "member-inline-status error";
        }
      } finally {
        setButtonBusy(submit, false);
      }
    });
  }

  const logout = document.querySelector("[data-member-logout]");
  const logoutDialog = document.querySelector("[data-member-logout-dialog]");
  const logoutCancel = logoutDialog?.querySelector("[data-member-logout-cancel]");
  const logoutConfirm = logoutDialog?.querySelector("[data-member-logout-confirm]");
  let logoutOpener = null;
  logout?.addEventListener("click", () => {
    if (!(logout instanceof HTMLButtonElement) || !(logoutDialog instanceof HTMLDialogElement)) return;
    logoutOpener = logout;
    logoutDialog.showModal();
    window.requestAnimationFrame(() => {
      if (logoutCancel instanceof HTMLButtonElement) logoutCancel.focus();
    });
  });
  logoutCancel?.addEventListener("click", () => {
    if (logoutDialog instanceof HTMLDialogElement) logoutDialog.close("cancel");
  });
  logoutDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (logoutDialog instanceof HTMLDialogElement) logoutDialog.close("cancel");
  });
  logoutDialog?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (logoutDialog instanceof HTMLDialogElement) logoutDialog.close("cancel");
  });
  logoutDialog?.addEventListener("close", () => {
    if (logoutOpener instanceof HTMLButtonElement && logoutOpener.isConnected) logoutOpener.focus();
    logoutOpener = null;
  });
  logoutConfirm?.addEventListener("click", async () => {
    if (!(logoutConfirm instanceof HTMLButtonElement)) return;
    setButtonBusy(logoutConfirm, true);
    try {
      await apiRequest("/api/session/logout", { method: "POST" });
      memberAuthChannel?.postMessage({ type: "authentication-lost" });
      window.location.replace("/");
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "You could not be signed out.";
        status.className = "form-status error";
        status.hidden = false;
      }
      setButtonBusy(logoutConfirm, false);
      if (logoutDialog instanceof HTMLDialogElement) logoutDialog.close("error");
    }
  });

  const deleteAccount = document.querySelector("[data-member-delete-account]");
  const deleteDialog = document.querySelector("[data-member-delete-dialog]");
  const deleteCancel = deleteDialog?.querySelector("[data-member-delete-cancel]");
  const deleteConfirm = deleteDialog?.querySelector("[data-member-delete-confirm]");
  deleteAccount?.addEventListener("click", async () => {
    if (!(deleteAccount instanceof HTMLButtonElement)) return;
    if (deleteDialog instanceof HTMLDialogElement) deleteDialog.showModal();
  });
  deleteCancel?.addEventListener("click", () => {
    if (deleteDialog instanceof HTMLDialogElement) deleteDialog.close();
  });
  deleteConfirm?.addEventListener("click", async () => {
    if (!(deleteConfirm instanceof HTMLButtonElement)) return;
    deleteConfirm.disabled = true;
    deleteConfirm.setAttribute("aria-busy", "true");
    deleteConfirm.textContent = "Deleting account…";
    try {
      await apiRequest("/api/member/account", { method: "DELETE" }, true);
      memberAuthChannel?.postMessage({ type: "authentication-lost" });
      window.location.replace("/");
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "Your account could not be deleted.";
        status.className = "form-status error";
        status.hidden = false;
      }
      deleteConfirm.disabled = false;
      deleteConfirm.removeAttribute("aria-busy");
      deleteConfirm.textContent = "Permanently delete account";
      if (deleteDialog instanceof HTMLDialogElement) deleteDialog.close();
    }
  });
}

function setupStcSignout() {
  const card = document.querySelector("[data-stc-signout]");
  const button = card?.querySelector("[data-stc-signout-confirm]");
  const status = card?.querySelector("[data-stc-signout-status]");
  if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;
  button.addEventListener("click", async () => {
    setButtonBusy(button, true);
    status.hidden = true;
    try {
      await apiRequest("/api/session/logout", { method: "POST" });
      clearMemberPrivateView();
      memberAuthChannel?.postMessage({ type: "authentication-lost" });
      window.location.replace("/");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "You could not be signed out.";
      status.className = "form-status error";
      status.hidden = false;
      setButtonBusy(button, false);
    }
  });
}

let memberRevalidationPromise = null;
function revalidateMemberSessionForCurrentView() {
  if (memberRevalidationPromise) return memberRevalidationPromise;
  if (revalidateProtectedSubmissionForms()) return sessionPromise;
  memberRevalidationPromise = (async () => {
    const dashboard = document.querySelector("[data-member-dashboard]");
    sessionPromise = loadMemberSession();
    if (dashboard) await resolveMemberDashboard(sessionPromise, true);
    else await sessionPromise;
  })().finally(() => {
    memberRevalidationPromise = null;
  });
  return memberRevalidationPromise;
}

function renderDevelopmentInbox(messages) {
  const list = document.querySelector("[data-development-inbox-list]");
  if (!list) return;
  clearNode(list);
  if (!messages.length) {
    list.append(textElement("p", "member-empty", "No local messages have been captured yet."));
    return;
  }
  for (const messageValue of messages) {
    const message = objectValue(messageValue);
    const card = document.createElement("article");
    card.className = "member-inbox-message";
    const heading = textElement("h2", "", message.subject || message.kind || "Email message");
    const sender = message.from || message.from_email || message.sender;
    const replyTo = message.reply_to || message.reply_to_email || message.replyTo;
    const meta = textElement("p", "member-dashboard-item-meta", [
      message.to || message.recipient_email,
      message.kind,
      message.delivery_mode || message.personalization_mode,
      message.provider || message.provider_name,
      sender ? `From ${sender}` : "",
      replyTo ? `Reply to ${replyTo}` : "",
      message.created_at ? readableDate(message.created_at) : "",
    ].filter(Boolean).join(" · "));
    card.append(heading, meta);
    const previewUrl = message.development_sign_in_url || message.preview_url;
    if (typeof previewUrl === "string") {
      try {
        const target = new URL(previewUrl, window.location.origin);
        if (target.origin === window.location.origin) {
          const link = document.createElement("a");
          link.className = "btn member-secondary-button";
          link.href = target.href;
          link.textContent = "Open message action";
          card.append(link);
        }
      } catch {
        // Ignore malformed local preview URLs.
      }
    }
    const html = message.html || message.html_body;
    if (typeof html === "string" && html.trim()) {
      const preview = document.createElement("section");
      preview.className = "member-inbox-preview";
      preview.append(textElement("p", "member-inbox-preview-label", "Email design preview"));
      const frame = document.createElement("iframe");
      frame.className = "member-inbox-preview-frame";
      frame.title = `Preview of ${String(message.subject || message.kind || "email message")}`;
      frame.loading = "lazy";
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.srcdoc = html;
      preview.append(frame);
      card.append(preview);
    }
    const content = message.text || message.text_body || message.body;
    if (typeof content === "string" && content) card.append(textElement("pre", "member-inbox-body", content));
    list.append(card);
  }
}

function setupDevelopmentInbox() {
  const inbox = document.querySelector("[data-development-inbox]");
  if (!inbox) return;
  const status = inbox.querySelector("[data-development-inbox-status]");
  const refresh = inbox.querySelector("[data-development-inbox-refresh]");
  const processNewsletter = inbox.querySelector("[data-development-newsletter-process]");
  const load = async () => {
    if (refresh instanceof HTMLButtonElement) refresh.disabled = true;
    try {
      const results = await Promise.allSettled([
        apiRequest("/api/dev/emails", { method: "GET" }),
        apiRequest("/api/dev/newsletters", { method: "GET" }),
      ]);
      const messages = [];
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const payload = objectValue(result.value);
        messages.push(...arrayValue(payload.emails || payload.messages || payload.newsletters || payload.jobs || payload.deliveries));
      }
      if (!messages.length && results.every((result) => result.status === "rejected")) {
        throw results[0].reason;
      }
      messages.sort((left, right) => String(objectValue(right).created_at || "").localeCompare(String(objectValue(left).created_at || "")));
      renderDevelopmentInbox(messages);
      if (status) {
        const partialFailure = results.some((result) => result.status === "rejected");
        status.textContent = partialFailure ? "Some local email messages could not be loaded. The available inbox is shown below." : "";
        status.className = partialFailure ? "form-status error" : "form-status";
        status.hidden = !partialFailure;
      }
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "The local inbox could not be loaded.";
        status.className = "form-status error";
        status.hidden = false;
      }
    } finally {
      if (refresh instanceof HTMLButtonElement) refresh.disabled = false;
    }
  };
  processNewsletter?.addEventListener("click", async () => {
    if (!(processNewsletter instanceof HTMLButtonElement)) return;
    processNewsletter.disabled = true;
    processNewsletter.setAttribute("aria-busy", "true");
    try {
      const payload = await apiRequest("/api/dev/newsletters/process", { method: "POST" });
      await load();
      if (status) {
        const queued = Number(payload.queued || 0);
        const processed = Number(payload.processed || 0);
        status.textContent = `Weekly digest ready. ${queued} message${queued === 1 ? "" : "s"} queued; ${processed} captured locally.`;
        status.className = "form-status success";
        status.hidden = false;
      }
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "The weekly digest could not be built.";
        status.className = "form-status error";
        status.hidden = false;
      }
    } finally {
      processNewsletter.disabled = false;
      processNewsletter.removeAttribute("aria-busy");
    }
  });
  refresh?.addEventListener("click", load);
  void load();
}

setupMemberSignin();
setupMemberVerification();
setupMemberDashboard();
setupStcSignout();
setupDevelopmentInbox();

for (const count of document.querySelectorAll("[data-rsvp-count]")) {
  const id = String(count.dataset.rsvpCount || "");
  if (!/^\d+$/.test(id)) continue;
  void apiRequest(`/api/events/${encodeURIComponent(id)}`, { method: "GET" })
    .then((payload) => setRsvpCount(id, objectValue(payload.event).rsvp_count))
    .catch(() => undefined);
}

memberAuthChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "authentication-lost") return;
  clearMemberPrivateView();
  const protectedForms = protectedSubmissionForms();
  if (protectedForms.length) {
    protectedForms.forEach(resetProtectedSubmissionForm);
    window.location.replace(protectedSubmissionSignInUrl());
    return;
  }
  if (document.querySelector("[data-member-dashboard]")) window.location.replace("/signin?return=%2Fme");
});

globalThis.addEventListener?.("pageshow", (event) => {
  syncCurrentNavigation();
  if (event.persisted) void revalidateMemberSessionForCurrentView();
});

globalThis.addEventListener?.("popstate", syncCurrentNavigation);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  syncCurrentNavigation();
  void revalidateMemberSessionForCurrentView();
});

void sessionPromise.then(() => {
  if (!memberState.authenticated) return;
  for (const button of document.querySelectorAll("[data-rsvp-event-id]")) {
    if (button instanceof HTMLButtonElement) setRsvpButton(button, false);
  }
  if (document.querySelector(".member-favorite") || document.querySelector("[data-rsvp-event-id]")) {
    void loadMemberDashboard().catch(() => undefined);
  }
});
