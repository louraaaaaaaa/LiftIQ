// DOM rendering for the Train and History pages. All state comes from WorkoutMachine snapshots;
// event wiring lives in app.js. (Not unit tested: needs a browser; see docs/UX_TRAIN_FLOW.md.)
import { PHASES } from "./workout.js";
import { pictogramSvg, resolveImage, creditLine } from "./exercises.js";
import { pulseChartSvg, allPulses } from "./pulse-chart.js";
import { datasetMediaHtml, wireDatasetMedia } from "./exercise-media.js";
import { SUPPORT_BADGE, SUPPORT_WARNING, PAGE_SIZE, paginate } from "./exercise-db.js";
import { formatWeight, hasWeight, repsText, setLabel, uniqueSetFileNames, formatDateTime } from "./set-format.js";

const IDS = [
  "workoutBar", "backButton", "barMachine", "barMeta", "barSensor", "barSensorText", "stageStepper", "stageAnnounce",
  "confirmRow", "confirmText", "confirmYes", "confirmNo",
  "trainHome", "trainWeight", "trainReady", "trainSet", "trainReview", "trainRest", "trainSummary",
  "resumeBanner", "resumeText", "resumeActions", "resumeConfirm",
  "homeConn", "homeConnText", "homeConnectButton", "recentBlock", "recentList", "exerciseList", "exerciseSearch",
  "customExerciseForm", "customExerciseName", "finishWorkoutHomeButton",
  "exerciseSentinel", "showMoreButton", "exerciseCount", "exerciseInfo", "supportBadge", "exerciseMeta", "movementBox", "movementBody",
  "instructionsBox", "instructionList", "supportWarning",
  "weightHero", "creditLine", "takePhotoButton", "pickPhotoButton", "removePhotoButton", "photoMessage",
  "setupSetNumber", "setupExerciseName", "setupCue", "setupLast", "exerciseNameEdit", "weightInput", "weightStepNote",
  "setNote", "removeMachineButton",
  "readyTitle", "sensorCard", "sensorCardTitle", "sensorCardBattery", "readyConnectButton", "stillRow", "stillRing",
  "stillTitle", "stillText", "readyHint", "setupMessage", "startSetButton", "startSetLabel",
  "repCount", "repNote", "setConnLost", "stopButton",
  "reviewTitle", "reviewCount", "reviewCountNote", "includeSetupRow", "includeSetupToggle", "includeSetupNote",
  "reviewWeightInput", "reviewChart", "reviewMetrics", "reviewBars", "reviewMessage", "repEditor", "repEditInput",
  "confirmRepsButton", "editCountButton", "discardSetButton",
  "restTitle", "restLast", "restClock", "restCountdown", "restFill", "restStatus", "nextSetButton",
  "summaryTitle", "summaryBody", "workoutHistory", "historyCount",
];

const STAGE_LABELS = { machine: "Machine", weight: "Weight", ready: "Ready check", set: "Set", review: "Review", rest: "Rest" };
const CONFIRM_TEXT = {
  "cancel-set": "Cancel this set? The recording is discarded.",
  "discard-set": "Really discard this set? The recorded data is deleted.",
};
const fmt = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d));
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Replace an action button by an inline "Really X? [Yes] [No]" row (no pop-up). */
export function inlineConfirm(anchor, text, onYes) {
  const host = anchor.closest(".history-actions") || anchor.parentElement;
  const existing = host.parentElement.querySelector(":scope > .inline-confirm");
  if (existing) { existing.querySelector("button:last-child").focus(); return; }
  const row = document.createElement("div");
  row.className = "inline-confirm";
  row.setAttribute("role", "group");
  row.innerHTML = `<span></span><button type="button" class="button button-stop">Yes</button><button type="button" class="button button-secondary">No</button>`;
  row.querySelector("span").textContent = text;
  const [yes, no] = row.querySelectorAll("button");
  no.addEventListener("click", () => { row.remove(); anchor.focus(); });
  yes.addEventListener("click", () => { row.remove(); onYes(); });
  host.after(row);
  no.focus();
}

export class TrainView {
  constructor() {
    this.el = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));
    this.lastStage = null;
    this.lastConfirm = null;
    this.reviewKey = "";
    this.exercises = [];
    this.photos = new Map();
    this.lastBy = {};
    this.library = new Map();
    this.media = { enabled: true, sha: null };
    this.list = [];
    this.page = 0;
    this.current = null; // library entry shown on the weight stage
    for (const id of ["exerciseList", "recentList", "movementBody"]) wireDatasetMedia(this.el[id]);
    this.el.showMoreButton.addEventListener("click", () => this.loadMore());
    this.el.movementBox.addEventListener("toggle", () => this.#movement());
    if (typeof IntersectionObserver === "function") {
      this.observer = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) this.loadMore(); }, { rootMargin: "500px 0px" });
      this.observer.observe(this.el.exerciseSentinel);
    }
  }

  setPhotos(map) { this.photos = map; }
  /** The merged library (seeds + custom + dataset) for details lookups. */
  setLibrary(list) { this.library = new Map(list.map((e) => [e.id, e])); }
  /** media = { enabled, sha } */
  setMedia(media) {
    this.media = { ...this.media, ...media };
    this.el.movementBox.open = false;
    this.el.movementBody.replaceChildren();
    delete this.el.movementBody.dataset.id;
  }

  // ---- machine picker ---------------------------------------------------------
  // Picture priority: own photo, packaged Wikimedia example, dataset thumbnail (online, with attribution), pictogram.
  #thumb(e) {
    const img = resolveImage(e, this.photos.get(e.id));
    if (img) return `<span class="ds-frame"><img src="${esc(img.url)}" alt="" loading="lazy" decoding="async">${img.label ? `<em class="example-tag">Example</em>` : ""}</span>`;
    const ds = e.ds && datasetMediaHtml({ sha: this.media.sha, kind: "image", file: e.ds.imageFile, alt: "", enabled: this.media.enabled, size: "thumb", placeholder: pictogramSvg(e.pictogram, { size: 40 }) });
    return ds || `<span class="ds-frame">${pictogramSvg(e.pictogram, { size: 44 })}</span>`;
  }

  #badge(e) {
    const text = SUPPORT_BADGE[e.support] || "";
    return text ? `<small class="support-badge is-${e.support}">${esc(text)}</small>` : "";
  }

  #cards(list, lastBy) {
    return list.map((e) => {
      const last = lastBy[e.id];
      const info = last
        ? `Last: ${hasWeight(last.weightKg) ? `${formatWeight(last.weightKg)} kg × ` : ""}${repsText(last.repsConfirmed)}`
        : [e.muscles?.[0], e.machine].filter(Boolean).join(" · ");
      return `<li class="ex-card" data-id="${esc(e.id)}">${this.#thumb(e)}
        <button class="ex-pick" type="button" data-id="${esc(e.id)}"><b>${esc(e.name)}</b>
          <small class="${last ? "last-line" : ""}">${esc(info)}</small>${this.#badge(e)}</button></li>`;
    }).join("");
  }

  /** `list` is the filtered, ordered library; `recent` the up-to-4 recent entries shown above (empty while filtering). */
  setExercises(list, lastBy = this.lastBy, { recent = [] } = {}) {
    this.list = list;
    this.lastBy = lastBy;
    this.page = 0;
    this.el.recentBlock.hidden = recent.length === 0;
    this.el.recentList.innerHTML = this.#cards(recent, lastBy);
    this.el.exerciseCount.textContent = list.length ? `· ${list.length}` : "";
    this.el.exerciseList.replaceChildren();
    if (!list.length) {
      this.el.exerciseList.innerHTML = '<li class="empty-history"><strong>No exercise matches</strong><span>Try "All", clear the filters, or type your own machine name above.</span></li>';
      this.el.showMoreButton.hidden = true;
      this.hasMore = false;
      return;
    }
    this.#appendPage();
  }

  #appendPage() {
    const { items, hasMore, nextPage } = paginate(this.list, this.page, PAGE_SIZE);
    this.el.exerciseList.insertAdjacentHTML("beforeend", this.#cards(items, this.lastBy));
    this.page = nextPage;
    this.hasMore = hasMore;
    this.el.showMoreButton.hidden = !hasMore || Boolean(this.observer);
  }

  loadMore() { if (this.hasMore) this.#appendPage(); }

  // movement GIF: only requested when the "Show movement" box is opened
  #movement() {
    const el = this.el;
    const ds = this.current?.ds;
    if (!el.movementBox.open || !ds) return;
    if (!this.media.enabled) { el.movementBody.textContent = "Online exercise previews are off (Sensor > Training settings)."; return; }
    if (el.movementBody.dataset.id === this.current.id && el.movementBody.firstElementChild) return;
    el.movementBody.dataset.id = this.current.id;
    el.movementBody.innerHTML = datasetMediaHtml({ sha: this.media.sha, kind: "gif", file: ds.gifFile, alt: `${this.current.name}: movement animation`, enabled: true, size: "full", placeholder: pictogramSvg(this.current.pictogram, { size: 72 }) })
      || "Preview not available.";
  }

  #exerciseInfo(lib) {
    const el = this.el;
    this.current = lib || null;
    const ds = lib?.ds;
    el.exerciseInfo.hidden = !ds;
    if (!ds) return;
    if (el.exerciseInfo.dataset.id !== lib.id) {
      el.exerciseInfo.dataset.id = lib.id;
      el.movementBox.open = false;
      el.movementBody.replaceChildren();
      delete el.movementBody.dataset.id;
      el.instructionsBox.open = false;
      el.instructionList.replaceChildren(...ds.steps.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
      const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
      const parts = [`Target: ${cap(ds.target)}`];
      if (ds.secondary.length) parts.push(`Also: ${ds.secondary.map(cap).join(", ")}`);
      parts.push(`Equipment: ${cap(ds.equipment)}`);
      el.exerciseMeta.textContent = parts.join(" · ");
    }
    const badge = SUPPORT_BADGE[lib.support] || "";
    el.supportBadge.textContent = badge;
    el.supportBadge.dataset.level = lib.support;
    el.supportBadge.hidden = !badge;
    el.instructionsBox.hidden = ds.steps.length === 0;
  }

  // ---- stages -----------------------------------------------------------------
  render(snap, ctx) {
    const el = this.el;
    const stage = snap.stage;
    const sections = { machine: el.trainHome, weight: el.trainWeight, ready: el.trainReady, set: el.trainSet, review: el.trainReview, rest: el.trainRest };
    const showing = snap.phase === PHASES.SUMMARY ? el.trainSummary : sections[stage];
    for (const node of [...Object.values(sections), el.trainSummary]) node.hidden = node !== showing;
    const changed = stage !== this.lastStage || (snap.phase === PHASES.SUMMARY) !== this.wasSummary;
    this.lastStage = stage;
    this.wasSummary = snap.phase === PHASES.SUMMARY;

    this.#bar(snap, ctx);
    this.#confirm(snap);
    this.#home(snap, ctx);
    if (stage === "weight") this.#weight(snap, changed);
    if (stage === "ready") this.#ready(snap, ctx);
    if (stage === "set") this.#set(snap, ctx);
    if (stage === "review") this.#review(snap, changed);
    if (stage === "rest") this.#rest(snap, changed);
    if (snap.phase === PHASES.SUMMARY) this.#summary(snap);

    if (changed) {
      el.stageAnnounce.textContent = snap.phase === PHASES.SUMMARY ? "Exercise summary" : `Step: ${STAGE_LABELS[stage]}`;
      const focusTarget = { machine: el.trainHome.querySelector("h1"), weight: el.setupExerciseName, ready: el.readyTitle, set: el.trainSet, review: el.reviewTitle, rest: el.restTitle }[stage];
      if (snap.phase === PHASES.SUMMARY) el.summaryTitle.focus({ preventScroll: true });
      else if (stage === "set") { el.trainSet.tabIndex = -1; el.trainSet.focus({ preventScroll: true }); }
      else focusTarget?.focus({ preventScroll: true });
      window.scrollTo?.({ top: 0 });
    }
  }

  #bar(snap, ctx) {
    const el = this.el;
    const show = snap.phase !== PHASES.HOME;
    el.workoutBar.hidden = !show;
    if (!show) return;
    el.barMachine.textContent = snap.exercise?.name || "Quick set";
    const parts = [`Set ${snap.setNumber}`];
    parts.push(hasWeight(snap.weightKg) ? `${formatWeight(snap.weightKg)} kg` : "weight ?");
    el.barMeta.textContent = snap.phase === PHASES.SUMMARY ? "Summary" : parts.join(" · ");
    el.backButton.hidden = [PHASES.REST, PHASES.SUMMARY].includes(snap.phase);
    el.barSensor.dataset.state = ctx.connected ? "on" : "off";
    el.barSensorText.textContent = ctx.connected ? `Sensor${ctx.batteryText ? ` ${ctx.batteryText}` : ""}` : "Sensor off";
    const order = ["machine", "weight", "ready", "set", "review", "rest"];
    const at = order.indexOf(snap.stage);
    [...el.stageStepper.children].forEach((li, i) => {
      li.classList.toggle("is-done", i < at);
      li.classList.toggle("is-current", i === at);
      if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }

  #confirm(snap) {
    const el = this.el;
    el.confirmRow.hidden = !snap.confirm;
    if (snap.confirm) {
      el.confirmText.textContent = CONFIRM_TEXT[snap.confirm] || "Really?";
      if (this.lastConfirm !== snap.confirm) el.confirmNo.focus();
    }
    this.lastConfirm = snap.confirm;
  }

  #home(snap, ctx) {
    const el = this.el;
    el.finishWorkoutHomeButton.hidden = !(snap.workout && snap.workout.blocks.some((b) => b.setIds.length));
    el.homeConn.hidden = ctx.connected; // the connect card collapses to the header chip once connected
    el.homeConnText.textContent = ctx.connecting ? "Connecting…" : "Sensor not connected";
    el.homeConnectButton.disabled = Boolean(ctx.connecting);
  }

  #weight(snap, changed) {
    const el = this.el;
    const e = this.exercises.find((x) => x.id === snap.exercise.id)?.image ? { ...snap.exercise, image: this.exercises.find((x) => x.id === snap.exercise.id).image } : snap.exercise;
    if (changed || el.setupExerciseName.dataset.name !== e.name) {
      el.setupExerciseName.textContent = e.name;
      el.setupExerciseName.dataset.name = e.name;
      el.exerciseNameEdit.value = e.name;
      el.setupCue.textContent = e.cue || "";
    }
    const img = resolveImage(e, this.photos.get(e.id));
    const heroKey = `${e.id}|${img?.url || ""}`;
    if (el.weightHero.dataset.key !== heroKey) {
      el.weightHero.dataset.key = heroKey;
      el.weightHero.innerHTML = img
        ? `<img src="${esc(img.url)}" alt="${esc(img.label || e.name)}">`
        : `<span class="hero-picto">${pictogramSvg(e.pictogram, { size: 96 })}</span>`;
    }
    this.#credit(img);
    this.#exerciseInfo(this.library.get(e.id));
    el.removePhotoButton.hidden = img?.kind !== "photo";
    el.takePhotoButton.textContent = img?.kind === "photo" ? "Retake photo" : "Take photo";
    el.removeMachineButton.hidden = !e.custom;
    el.setupSetNumber.textContent = String(snap.setNumber);
    const last = snap.lastSet;
    el.setupLast.textContent = last
      ? `Last set: ${hasWeight(last.weightKg) ? `${formatWeight(last.weightKg)} kg × ` : ""}${repsText(last.repsConfirmed)}`
      : "First time with this machine.";
    if (document.activeElement !== el.weightInput) el.weightInput.value = hasWeight(snap.weightKg) ? formatWeight(snap.weightKg) : "";
    if (changed) el.setNote.value = snap.note || "";
    el.weightStepNote.textContent = `Step ${snap.stepKg} kg`;
  }

  // attribution under the image: label for generic example photos, "Photo: author, licence - Wikimedia Commons" linked to the source
  #credit(img) {
    const el = this.el.creditLine;
    el.replaceChildren();
    el.hidden = !(img?.kind === "pack" && img.credit);
    if (el.hidden) return;
    if (img.label) el.append(Object.assign(document.createElement("b"), { textContent: `${img.label}. ` }));
    const link = Object.assign(document.createElement("a"), { textContent: creditLine(img), href: img.sourceUrl || "#", target: "_blank", rel: "noopener noreferrer" });
    el.append(link);
  }

  showPhotoMessage(text) { this.el.photoMessage.textContent = text; }

  #ready(snap, ctx) {
    const el = this.el;
    const r = snap.readiness;
    let state = "offline";
    if (ctx.connected) state = r.ready ? "ready" : r.still ? "settling" : "moving";
    el.sensorCard.dataset.state = state;
    el.sensorCardTitle.textContent = ctx.connected ? (ctx.sensorName || "Sensor") + (state === "ready" ? " · ready ✓" : " · connected") : (ctx.connecting ? "Connecting…" : "Sensor not connected");
    el.sensorCardBattery.textContent = ctx.connected && ctx.batteryText ? `Battery ${ctx.batteryText}` : "";
    el.sensorCardBattery.hidden = !(ctx.connected && ctx.batteryText);
    el.readyConnectButton.hidden = ctx.connected;
    el.readyConnectButton.disabled = Boolean(ctx.connecting);
    el.stillRow.hidden = !ctx.connected;
    el.stillRing.style.strokeDashoffset = String(100 - Math.round(r.progress * 100));
    el.stillTitle.textContent = state === "ready" ? "Ready ✓" : "Keep the machine still";
    el.stillText.textContent = state === "ready"
      ? "Press Start set whenever you are in position."
      : state === "moving" ? "Waiting for the machine to settle…" : `Still for ${r.stillS.toFixed(1)} s…`;
    el.readyHint.hidden = !snap.readyHint;
    el.setupMessage.textContent = snap.error || "";
    const hold = 1.5;
    el.startSetButton.disabled = !ctx.connected;
    el.startSetButton.classList.toggle("is-arming", snap.arming);
    el.startSetLabel.textContent = snap.arming
      ? `Hold still… ${Math.max(0, hold - r.stillS).toFixed(1)} s (tap to cancel)`
      : "Start set";
  }

  #set(snap, ctx) {
    const el = this.el;
    el.repCount.textContent = String(snap.live.count);
    el.repNote.textContent = snap.live.ready
      ? "Counts the first (setup) pull too; you can exclude it after the set."
      : "Waiting for the first still second…";
    el.setConnLost.hidden = ctx.connected;
  }

  #review(snap, changed) {
    const el = this.el;
    const r = snap.review;
    if (!r) return;
    el.reviewCount.textContent = String(r.count);
    el.reviewCountNote.textContent = r.edited
      ? `reps (you edited it; detected ${r.detected})`
      : `reps detected${r.includeSetup ? " (setup pull included)" : r.flagged ? " (setup pull excluded)" : ""}`;
    el.confirmRepsButton.textContent = `Yes, ${r.count} ${r.count === 1 ? "rep" : "reps"}`;
    el.confirmRepsButton.disabled = r.saving;
    el.discardSetButton.disabled = r.saving;
    el.includeSetupRow.hidden = !r.flagged;
    el.includeSetupToggle.checked = r.includeSetup;
    el.includeSetupNote.textContent = r.includeSetup
      ? `Counting the first pull as a rep (${r.repsWithSetup} reps).`
      : `The first, longer pull looks like a setup pull and is not counted (${r.repsExcludingSetup} reps).`;
    el.reviewMessage.textContent = snap.error || "";
    const warn = SUPPORT_WARNING[this.library.get(snap.exercise?.id)?.support] || "";
    el.supportWarning.textContent = warn;
    el.supportWarning.hidden = !warn;
    if (document.activeElement !== el.reviewWeightInput) el.reviewWeightInput.value = hasWeight(snap.weightKg) ? formatWeight(snap.weightKg) : "";
    if (changed) { this.editing = false; el.repEditor.hidden = true; }
    if (!el.repEditor.hidden && document.activeElement !== el.repEditInput) el.repEditInput.value = String(r.count);

    const key = `${r.includeSetup}|${r.analysis.totalPulses}|${r.sampleCount}`;
    if (key !== this.reviewKey || changed) {
      this.reviewKey = key;
      const a = r.analysis;
      const all = allPulses(a);
      // chart shows every pulse; the setup pull is highlighted and labelled S when excluded
      el.reviewChart.innerHTML = pulseChartSvg(a.series, all, { includeSetup: r.includeSetup });
      const m = a.metrics;
      el.reviewMetrics.innerHTML = [
        ["Mean peak velocity", `${fmt(m.meanPeakVelocity)} m/s`],
        ["Velocity loss", m.velocityLossPct === null ? "— (needs 4+ reps)" : `${fmt(m.velocityLossPct, 0)} %`],
        ["Mean rep period", `${fmt(m.meanRepPeriodS, 1)} s`],
        ["Mean up-stroke", `${fmt(m.meanUpstrokeCm, 0)} cm (est.)`],
      ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
      const maxV = Math.max(0.01, ...all.map((p) => p.vPeak));
      let n = 0;
      el.reviewBars.innerHTML = all.map((p) => {
        const excluded = p.setup && !r.includeSetup;
        const label = excluded ? "Setup" : `Rep ${++n}`;
        return `<li class="${excluded ? "is-setup" : ""}"><span class="bar-label">${label}</span>
          <span class="bar-track"><span style="width:${(100 * p.vPeak / maxV).toFixed(0)}%"></span></span>
          <span class="bar-values">${fmt(p.vPeak)} m/s · ${fmt(p.upstrokeCm, 0)} cm · ${p.timeToNextS === null ? "end" : `${fmt(p.timeToNextS, 1)} s`}</span></li>`;
      }).join("");
    }
  }

  showEditor(show, count) {
    this.el.repEditor.hidden = !show;
    this.el.editCountButton.textContent = show ? "Done editing" : "Edit count";
    if (show) { this.el.repEditInput.value = String(count); this.el.repEditInput.focus(); }
  }

  #rest(snap, changed) {
    const el = this.el;
    const s = snap.lastSet;
    if (s) el.restLast.textContent = setLabel(s);
    el.nextSetButton.textContent = `Next set (set ${snap.sets.length + 1})`;
    if (changed) el.restClock.classList.remove("is-done");
    this.renderRest(snap);
  }

  renderRest(snap) {
    const el = this.el;
    if (snap.phase !== PHASES.REST || !snap.rest) return;
    const rest = snap.rest;
    el.restCountdown.textContent = clock(rest.remainingS);
    const frac = rest.totalS > 0 ? Math.min(1, rest.remainingS / rest.totalS) : 0;
    el.restFill.style.width = `${(frac * 100).toFixed(0)}%`;
    const over = rest.remainingS === 0;
    el.restClock.classList.toggle("is-done", over && !rest.skipped);
    el.restStatus.textContent = over ? (rest.skipped ? "Rest skipped." : "Rest over. Ready for the next set.") : "";
  }

  #summary(snap) {
    const rows = snap.summary || [];
    this.el.summaryTitle.textContent = snap.exercise?.name || "Summary";
    this.el.summaryBody.innerHTML = rows.map((r) => `<tr><th scope="row">${r.setNumber}</th><td>${hasWeight(r.weightKg) ? formatWeight(r.weightKg) : "—"}</td><td>${r.reps}</td><td>${fmt(r.meanPeakVelocity)}</td><td>${r.velocityLossPct === null ? "—" : `${fmt(r.velocityLossPct, 0)} %`}</td><td>${fmt(r.meanRepPeriodS, 1)}</td></tr>`).join("");
  }

  renderResume(pending) {
    const el = this.el;
    el.resumeBanner.hidden = !pending;
    if (pending) {
      el.resumeText.textContent = `${pending.completedSets} set${pending.completedSets === 1 ? "" : "s"} saved${pending.exerciseName ? ` · ${pending.exerciseName}, set ${pending.setNumber}` : ""} · started ${formatDateTime(pending.startedAt)}.`;
    }
  }

  // ---- history ----------------------------------------------------------------
  renderWorkoutHistory(workouts, sets, { onDownload, onDelete, loadSamples, analyze }) {
    const root = this.el.workoutHistory;
    this.el.historyCount.textContent = `${sets.length} ${sets.length === 1 ? "set" : "sets"} saved`;
    root.replaceChildren();
    if (!sets.length) {
      root.innerHTML = '<div class="empty-history"><span class="empty-icon" aria-hidden="true">↗</span><strong>No workouts yet</strong><span>Your sets, readable names and CSV files will show up here.</span></div>';
      return;
    }
    const names = uniqueSetFileNames(sets);
    const byWorkout = new Map();
    for (const s of sets) {
      if (!byWorkout.has(s.workoutId)) byWorkout.set(s.workoutId, []);
      byWorkout.get(s.workoutId).push(s);
    }
    const ordered = [...workouts].filter((w) => byWorkout.has(w.id));
    for (const [id] of byWorkout) if (!ordered.some((w) => w.id === id)) ordered.push({ id, startedAt: byWorkout.get(id)[0].startedAt, blocks: [] });
    ordered.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    let lastDay = "";
    for (const w of ordered) {
      const day = new Date(w.startedAt).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        const h = document.createElement("h2");
        h.className = "history-day";
        h.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(w.startedAt));
        root.append(h);
      }
      const card = document.createElement("section");
      card.className = "workout-card";
      const wsets = byWorkout.get(w.id).sort((a, b) => a.setNumber - b.setNumber);
      const blockIds = w.blocks.length ? w.blocks.map((b) => b.id) : [...new Set(wsets.map((s) => s.blockId))];
      const head = document.createElement("p");
      head.className = "eyebrow";
      head.textContent = `WORKOUT · ${formatDateTime(w.startedAt)} · ${wsets.length} ${wsets.length === 1 ? "set" : "sets"}`;
      card.append(head);
      for (const blockId of blockIds) {
        const bsets = wsets.filter((s) => s.blockId === blockId);
        if (!bsets.length) continue;
        const title = document.createElement("h3");
        title.className = "block-title";
        title.textContent = bsets[0].exerciseName;
        card.append(title);
        for (const s of bsets) card.append(this.#setItem(s, names.get(s.id), { onDownload, onDelete, loadSamples, analyze }));
      }
      root.append(card);
    }
  }

  #setItem(set, fileName, { onDownload, onDelete, loadSamples, analyze }) {
    const d = document.createElement("details");
    d.className = "set-item";
    const sum = document.createElement("summary");
    sum.textContent = setLabel(set);
    d.append(sum);
    const body = document.createElement("div");
    body.className = "set-body";
    const m = set.metrics || {};
    body.innerHTML = `<dl class="metric-grid">
      <div><dt>Reps</dt><dd>${set.repsConfirmed} <small>${set.repsSource === "user-edited" ? "edited" : "sensor-confirmed"}; detected ${set.repsDetectedExcludingSetup} / ${set.repsDetectedWithSetup} with setup${set.setupPullIncluded ? ", setup pull counted" : ""}</small></dd></div>
      <div><dt>Mean peak velocity</dt><dd>${fmt(m.meanPeakVelocity)} m/s</dd></div>
      <div><dt>Velocity loss</dt><dd>${m.velocityLossPct === null || m.velocityLossPct === undefined ? "—" : `${fmt(m.velocityLossPct, 0)} %`}</dd></div>
      <div><dt>Rep period</dt><dd>${fmt(m.meanRepPeriodS, 1)} s</dd></div>
      <div><dt>Rest before next</dt><dd>${set.restS === null || set.restS === undefined ? "—" : `${set.restS} s`}</dd></div></dl>
      ${set.note ? `<p class="muted">Note: ${esc(set.note)}</p>` : ""}
      <div class="history-chart"></div>`;
    const actions = document.createElement("div");
    actions.className = "history-actions";
    const csv = document.createElement("button");
    csv.type = "button";
    csv.className = "icon-button";
    csv.textContent = "↓ CSV";
    csv.title = fileName;
    csv.setAttribute("aria-label", `Download CSV ${fileName}`);
    csv.addEventListener("click", () => onDownload(set, fileName));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-button delete-button";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${setLabel(set)}`);
    del.addEventListener("click", () => onDelete(set, del));
    actions.append(csv, del);
    body.append(actions);
    d.append(body);
    let loaded = false;
    d.addEventListener("toggle", async () => {
      if (!d.open || loaded) return;
      loaded = true;
      const samples = await loadSamples(set.id);
      if (!samples?.length) return;
      const a = analyze(samples, { includeSetupPull: set.setupPullIncluded });
      body.querySelector(".history-chart").innerHTML = pulseChartSvg(a.series, allPulses(a), { includeSetup: set.setupPullIncluded });
    });
    return d;
  }
}
