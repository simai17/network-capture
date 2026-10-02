/* Network capture: phone UI. Entries are encrypted the moment they are saved. */
"use strict";

const C = window.NetmapCapture;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MAX_PHOTOS = 3;
const KIND_LABEL = { person: "Person", event: "Event", followup: "Follow-up" };

const state = { config: null, settings: {}, event: null, photos: [], lastResult: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const fileStamp = (d) => `${isoDate(d).replaceAll("-", "")}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : C.b64(crypto.getRandomValues(new Uint8Array(12))).replace(/[^a-z0-9]/gi, "x"));

let toastTimer;
function toast(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 2200);
}

// ------------------------------------------------------------- navigation
let currentScreen = "home";
function show(id, push = true) {
  for (const screen of $$(".screen")) screen.hidden = screen.id !== id;
  window.scrollTo(0, 0);
  // One history step per form, so the phone's back gesture always returns home
  // (also after several "Save & next").
  if (push && id !== "home" && id !== currentScreen) history.pushState({ screen: id }, "", `#${id}`);
  currentScreen = id;
  if (id === "home") renderHome();
}
window.addEventListener("popstate", () => show(history.state?.screen || "home", false));

// ------------------------------------------------------------------- home
async function renderHome() {
  renderEventBar();
  await renderQueue();
  $("#fine").textContent = state.config
    ? `Entries are encrypted on this phone before they are stored or sent. Key ${state.config.kid}.`
    : "";
}

function renderEventBar() {
  const bar = $("#event-bar");
  bar.classList.toggle("active", Boolean(state.event));
  if (state.event) {
    bar.replaceChildren(
      h("div", { class: "what" }, h("span", { class: "label" }, "At"), h("span", { class: "name" }, state.event.name),
        h("span", { class: "label" }, [state.event.date, state.event.location].filter(Boolean).join(" · "))),
      h("button", { type: "button", class: "btn small", onclick: endEvent }, "End"));
  } else {
    bar.replaceChildren(
      h("div", { class: "what" }, h("span", { class: "label" }, "Not at an event"), h("span", {}, "Start one to mark everyone you meet there.")),
      h("button", { type: "button", class: "btn small", onclick: () => openForm("event") }, "Start"));
  }
}

async function endEvent() {
  if (!confirm(`End “${state.event.name}”? People you add afterwards are no longer marked as met there.`)) return;
  state.event = null;
  await C.kvDelete("event");
  renderEventBar();
}

async function renderQueue() {
  const items = await C.queueAll();
  const box = $("#queue");
  const setupMissing = !state.settings.repo || !state.settings.token;
  const parts = [];
  if (setupMissing) {
    parts.push(h("div", { class: "setup" }, "Add your inbox repository and token once, then entries are sent automatically.",
      h("div", {}, h("button", { type: "button", class: "btn small", onclick: () => openSettings() }, "Open settings"))));
  }
  if (items.length) {
    parts.push(h("h3", {}, `Waiting to send (${items.length})`,
      h("button", { type: "button", class: "btn small", onclick: () => sendNow(true) }, "Send now")));
    parts.push(h("ul", {}, items.map((item) => h("li", {},
      h("span", { class: "kind" }, KIND_LABEL[item.kind] || item.kind),
      h("span", { class: "lbl" }, item.label, item.error ? h("span", { class: "err" }, item.error) : null),
      h("span", { class: "time" }, item.created.slice(11, 16))))));
  } else if (!setupMissing) {
    parts.push(h("ul", {}, h("li", { class: "all-sent" }, state.lastResult?.sent ? `All sent (${state.lastResult.sent} just now).` : "Nothing waiting. Everything is in your inbox.")));
  }
  box.replaceChildren(...parts);
  renderStatus(items.length);
}

function renderStatus(waiting) {
  const el = $("#status");
  const r = state.lastResult;
  el.className = "status";
  if (r?.error === "auth") { el.classList.add("error"); el.textContent = "Check settings"; return; }
  if (!waiting) { el.classList.add("ok"); el.textContent = "All sent"; return; }
  el.classList.add("waiting");
  el.textContent = `${waiting} waiting${navigator.onLine ? "" : " · offline"}`;
}

// ---------------------------------------------------------------- sending
async function sendNow(manual = false) {
  if (!state.settings.repo || !state.settings.token) {
    if (manual) toast("Add the inbox repository and token in Settings first.", true);
    return renderQueue();
  }
  const result = await C.sendQueue();
  state.lastResult = result;
  if (result.error === "auth") {
    toast(`GitHub did not accept the token or repository (${result.status}). Check Settings.`, true);
  } else if (result.error === "offline") {
    if (manual) toast("No connection. Entries stay on the phone and are sent later.");
  } else if (result.sent) {
    toast(`Sent ${result.sent} ${result.sent === 1 ? "entry" : "entries"}`);
  } else if (result.failed) {
    toast(`${result.failed} could not be sent; they stay in the queue.`, true);
  }
  await renderQueue();
  return result;
}

async function enqueue(kind, label, payload) {
  const now = new Date();
  const id = uuid();
  const full = { v: 1, id, kind, created: isoLocal(now), ...payload };
  const envelope = await C.encryptEntry(state.config.publicKey, state.config.kid, full);
  await C.queuePut({ id, kind, label, created: full.created, file: `${fileStamp(now)}-${id.slice(0, 8)}.json`, envelope });
  // Ask for background sync if a service worker is active; never wait for one.
  navigator.serviceWorker?.getRegistration()
    .then((reg) => reg?.sync?.register("send-queue"))
    .catch(() => { /* background sync not available */ });
  if (navigator.onLine) sendNow();
  else renderQueue();
}

// ------------------------------------------------------------------ forms
function openForm(id) {
  const form = $(`#${id}`);
  form.reset();
  $$(".missing", form).forEach((el) => el.classList.remove("missing"));
  if (id === "person") {
    clearPhotos();
    const hasEvent = Boolean(state.event);
    $("#met-wrap").hidden = !hasEvent;
    form.elements.met.checked = hasEvent;
    if (hasEvent) $("#met-label").textContent = `Met at ${state.event.name}`;
  }
  if (id === "event") form.elements.date.value = isoDate();
  if (id === "followup") {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    form.elements.date.value = isoDate(d);
  }
  show(id);
  setTimeout(() => form.querySelector("input")?.focus(), 50);
}

function requireFields(form, names) {
  let ok = true;
  for (const name of names) {
    const input = form.elements[name];
    const missing = !input.value.trim();
    input.closest(".field").classList.toggle("missing", missing);
    if (missing && ok) { input.focus(); ok = false; }
  }
  return ok;
}

const val = (form, name) => (form.elements[name]?.value || "").trim();

async function savePerson(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!requireFields(form, ["name"])) return;
  const next = ev.submitter?.dataset.next === "1";
  const person = {
    name: val(form, "name"), organisation: val(form, "organisation"), title: val(form, "title"),
    email: val(form, "email"), phone: val(form, "phone"),
    tags: val(form, "tags").split(",").map((t) => t.trim()).filter(Boolean), note: val(form, "note"),
  };
  const met = state.event && form.elements.met.checked ? { ref: state.event.ref, name: state.event.name, date: state.event.date } : null;
  const followUp = val(form, "fu_date") ? { date: val(form, "fu_date"), note: val(form, "fu_note") } : null;
  const photos = state.photos.map(({ type, data }) => ({ type, data }));
  await enqueue("person", person.name, { person, met_at: met, follow_up: followUp, photos });
  toast(`Saved ${person.name}`);
  if (next) openForm("person");
  else history.back();
}

async function saveEvent(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!requireFields(form, ["name", "date"])) return;
  const ref = uuid();
  const event = {
    ref, name: val(form, "name"), date: val(form, "date"), end_date: val(form, "end_date"),
    location: val(form, "location"), kind: val(form, "kind"), note: val(form, "note"),
  };
  state.event = { ref, name: event.name, date: event.date, location: event.location };
  await C.kvSet("event", state.event);
  await enqueue("event", event.name, { event });
  toast(`At ${event.name}. Add the people you meet.`);
  history.back();
}

async function saveFollowup(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!requireFields(form, ["person", "date"])) return;
  const followup = { person: val(form, "person"), date: val(form, "date"), note: val(form, "note") };
  await enqueue("followup", followup.person, { followup });
  toast(`Follow-up for ${followup.person} saved`);
  history.back();
}

// ----------------------------------------------------------------- photos
async function compress(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bitmap = await createImageBitmap(file); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  return { type: "image/jpeg", data: C.b64(new Uint8Array(await blob.arrayBuffer())), url: URL.createObjectURL(blob) };
}

function renderThumbs() {
  $("#thumbs").replaceChildren(...state.photos.map((p, i) => h("div", { class: "thumb" },
    h("img", { src: p.url, alt: `Photo ${i + 1}` }),
    h("button", { type: "button", "aria-label": `Remove photo ${i + 1}`, onclick: () => { URL.revokeObjectURL(p.url); state.photos.splice(i, 1); renderThumbs(); } }, "×"))));
}

function clearPhotos() {
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  state.photos = [];
  renderThumbs();
}

for (const input of $$("[data-photo]")) {
  input.addEventListener("change", async () => {
    for (const file of input.files) {
      if (state.photos.length >= MAX_PHOTOS) { toast(`At most ${MAX_PHOTOS} photos per person.`); break; }
      try { state.photos.push(await compress(file)); } catch { toast("Could not read this image.", true); }
    }
    input.value = "";
    renderThumbs();
  });
}

// --------------------------------------------------------------- settings
function openSettings() {
  const form = $("#settings");
  form.elements.repo.value = state.settings.repo || "";
  form.elements.token.value = state.settings.token || "";
  form.elements.branch.value = state.settings.branch || "";
  $("#test-result").textContent = "";
  show("settings");
}

/** Accept "owner/name" as well as a pasted https://github.com/owner/name(.git) URL. */
const normaliseRepo = (text) => text.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");

async function saveSettings(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const repo = normaliseRepo(val(form, "repo"));
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast("Repository as owner/name, e.g. jane/network-inbox", true); return; }
  state.settings = { repo, token: val(form, "token"), branch: val(form, "branch") || "main" };
  await C.kvSet("settings", state.settings);
  state.lastResult = null;
  toast("Settings saved");
  history.back();
  sendNow();
}

async function testConnection() {
  const form = $("#settings");
  const repo = normaliseRepo(val(form, "repo")), token = val(form, "token");
  const out = $("#test-result");
  if (!repo || !token) { out.textContent = "Fill in repository and token first."; return; }
  out.textContent = "Checking…";
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (res.ok) {
      const info = await res.json();
      const write = info.permissions ? (info.permissions.push ? "yes" : "no (give the token “Contents: Read and write”)") : "not reported";
      out.textContent = `Connected to ${info.full_name}${info.private ? " (private)" : " — warning: this repository is public!"}. Write access: ${write}.`;
    } else if (res.status === 401) out.textContent = "The token was not accepted (expired or mistyped?).";
    else if (res.status === 404) out.textContent = "Repository not found, or the token has no access to it.";
    else out.textContent = `GitHub answered ${res.status}.`;
  } catch {
    out.textContent = "No connection to GitHub.";
  }
}

// -------------------------------------------------------------------- boot
async function init() {
  try {
    const res = await fetch("config.json", { cache: "no-cache" });
    state.config = await res.json();
    if (!state.config.publicKey) throw new Error("no key");
  } catch {
    $("#main").replaceChildren(h("div", { class: "setup" }, "This copy of the app has no key yet. Create it on the laptop with “network phone setup” and publish the generated folder."));
    return;
  }
  $("#kid").textContent = state.config.kid;
  $("#version").textContent = state.config.version || "–";
  state.settings = (await C.kvGet("settings")) || {};
  state.event = (await C.kvGet("event")) || null;

  $$("[data-open]").forEach((b) => b.addEventListener("click", () => openForm(b.dataset.open)));
  $$("[data-cancel]").forEach((b) => b.addEventListener("click", () => history.back()));
  $("#settings-btn").addEventListener("click", openSettings);
  $("#status").addEventListener("click", () => sendNow(true));
  $("#person").addEventListener("submit", savePerson);
  $("#event").addEventListener("submit", saveEvent);
  $("#followup").addEventListener("submit", saveFollowup);
  $("#settings").addEventListener("submit", saveSettings);
  $("#test-conn").addEventListener("click", testConnection);
  $("#show-token").addEventListener("click", (ev) => {
    const input = $("#settings").elements.token;
    input.type = input.type === "password" ? "text" : "password";
    ev.currentTarget.textContent = input.type === "password" ? "Show" : "Hide";
  });
  window.addEventListener("online", () => sendNow());
  window.addEventListener("offline", () => renderQueue());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sendNow(); });
  navigator.serviceWorker?.addEventListener("message", (ev) => { if (ev.data === "queue-changed") renderQueue(); });

  history.replaceState({ screen: "home" }, "", location.pathname);
  show("home", false);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.onLine) sendNow();
}

init();
