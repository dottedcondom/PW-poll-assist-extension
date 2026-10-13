/**
 * PW Live Poll Auto-Submit — content script
 *
 * Displays a small control docked next to the poll icon during live
 * PW.live classes, letting you pre-select an answer. When a poll appears
 * on screen, the script selects that answer and submits it. Only
 * operates on live classes (identified by the presence of #poll-icon) —
 * see the "Main observer loop" section below for why recorded classes
 * are out of scope.
 *
 * Design notes / known fragility:
 * - The button is deliberately NEVER inserted into PW.live's own DOM
 *   tree. Earlier versions did this and it broke when the site's
 *   framework (React) re-rendered that toolbar — React doesn't know
 *   about foreign nodes it didn't create, so it repositions its own
 *   buttons on re-render but leaves ours stuck in place. Instead, the
 *   button lives independently (fixed position, appended to <body>) and
 *   its coordinates are recalculated every animation frame from the real
 *   poll icon's live getBoundingClientRect(), so it always visually
 *   tracks the toolbar no matter how the site's layout shifts (opening
 *   chat, resizing, etc.).
 * - PW.live's poll markup has changed shape between examples seen during
 *   development (radio inputs sometimes carry a `value` attribute,
 *   sometimes don't). Detection therefore matches on the *visible*
 *   option letter text rather than the `value` attribute, and clicks the
 *   whole option button (the thing a real user would click).
 * - The Submit button has been observed living outside the poll's own
 *   DOM subtree, so it's searched for across the whole page rather than
 *   scoped to the poll container.
 * - The most reliable detection signal is the WebSocket poll_start event
 *   (see "WebSocket-driven poll detection" near the bottom of this
 *   file) — DOM/color-based detection exists only as a fallback for
 *   when that event is ever missed.
 * - The site's poll icon is a *toggle* (click = open, click again = close),
 *   so clicking it blindly is dangerous. Each poll is therefore handled by
 *   ONE "session" driven by ONE loop (see "Poll session"), and the only
 *   place the icon is ever clicked automatically is maybeOpenPanel(): only
 *   when no poll UI is visible (after one browser-task yield, not a timer),
 *   never right
 *   after the user touched the icon themselves, and rate-limited across
 *   every trigger (WebSocket event, icon color change, arming an answer).
 * - A poll's deadline is measured from when the event was *received*, not
 *   from the payload's server-side pollStartTime: client clocks drift, and
 *   trusting the server timestamp made polls look "already expired".
 * - Click timing. Measured on the real PW.live: it refuses a Submit that
 *   comes less than ~10 ms after the option click (an error such as
 *   "Unauthorised Scope Access"), while the first click can go the instant the
 *   poll is drawn. So the default "fast" mode acts at once and keeps
 *   MIN_SUBMIT_GAP_MS between the option click and Submit; "careful" also waits a
 *   painted frame (+ a floor) before the first click and before Submit, like the
 *   original; "exact" adds nothing of its own (the user's delay decides). If
 *   PW.live refuses a Submit anyway, "fast" learns a longer gap for the next polls.
 *   In every mode: Submit is only clicked once the page has visibly registered
 *   the option; an ignored option click is retried (OPTION_MAX_TRIES) rather than
 *   followed by an empty Submit; an option the page rebuilt is followed, never
 *   re-clicked (a 2nd click can unselect it); an already-selected option is never
 *   clicked; and the page's own error messages are noticed and attributed to the
 *   step they followed (see "What the PAGE says back").
 * - Time-critical steps use nextFrame(): requestAnimationFrame with a timer
 *   fallback, because rAF never fires while the class tab is in the background.
 * - If PW.live changes its markup further, the things most likely to
 *   need updating are POLL_HEADING_MATCH and the button-matching logic
 *   in findMatchingOptionButton / findSubmitButton.
 */
(function () {
  "use strict";

  // ================= Config (fixed, not user-editable) =================
  const CONFIG = {
    TOOLBAR_WAIT_MS: 2500, // grace period to wait for #poll-icon to appear at all before concluding this page has no live class
    OPTION_FIND_TIMEOUT_MS: 800, // how long to wait for option buttons to render before giving up
    SUBMIT_TIMEOUT_MS: 2000, // how long to wait for Submit to become clickable before giving up
    POLL_GONE_CHECK_MS: 1000,
    POLL_HEADING_MATCH: "choice poll", // lowercase substring match against heading text
    ICON_SIZE: 40,
    DOCK_GAP: 8, // px gap between our icon and the real poll icon
    AUTO_OPEN_RETRY_MS: 250, // floor between ANY two clicks we make on the poll icon (it is a toggle); only stops two triggers firing in the same instant
    OPEN_HOLD_MS: 1000, // most we hold off opening the panel while the PREVIOUS poll's UI is still on screen and unchanged (i.e. it's evidently open)
    OPEN_VERIFY_MS: 1200, // after our click, how long to wait for the poll to show up before a single retry
    MAX_OPEN_CLICKS: 2, // per poll: the 2nd click only ever happens for an armed answer whose panel still didn't show up
    STALE_UI_TIMEOUT_MS: 400, // longest an on-screen UI that is state-for-state identical to the PREVIOUS poll's is treated as "old" rather than the new poll
    SUBMIT_CONFIRM_MS: 3000, // how long after clicking Submit we look for any sign the page took it, before saying it didn't confirm
    MIN_SUBMIT_GAP_MS: 10, // PW.live refuses a Submit that follows the option click by less than this (measured on the real page: 0 ms is refused, 10 ms works). "fast" mode never goes below it
    PACE_MS: 24, // "careful" mode: least time from the poll UI first appearing to the first click (about what the original left). Fast mode skips it
    PACE_SUBMIT_MS: 16, // "careful" mode: least time from the option click to Submit (one frame, like the original). Fast mode skips it
    OPTION_RETRY_AFTER_ERROR_MS: 60, // ...but when the page has explicitly said no (an "Unauthorised..." message), retry after 60ms x tries instead
    OPTION_RETRY_MS: 300, // no sign the page took the option click after this long -> click again (it's safe: nothing is selected)
    OPTION_MAX_TRIES: 3, // ...up to this many clicks in total; after that we stop WITHOUT submitting an empty answer
    SUBMIT_SAFETY_MARGIN_MS: 300, // leave this much of the poll's real window for the click itself to land
    POLL_END_GRACE_MS: 1500, // keep working this long past the reported expiry (latency / clock slop) before giving up
    UNKNOWN_POLL_WINDOW_MS: 60000, // window to assume when a poll is detected without WebSocket timing info
    SIGNAL_MERGE_MS: 4000, // the icon color change and the WS "start" frame within this window are the same poll
    POST_POLL_QUIET_MS: 1500, // after a poll ends, ignore DOM-only "new poll" detection this long (results views reuse the poll markup)
    SCAN_INTERVAL_MS: 0, // 0 = look at the DOM on every step. Scanning is cheap; any throttle would just be added latency
    BACKGROUND_TICK_MS: 120, // timer fallback for when requestAnimationFrame is paused (background tab)
  };

  // ================= User settings (editable via the extension popup) =================
  // Kept in chrome.storage.local (key "settings") so the popup and this
  // content script always agree, and so a change made in the popup takes
  // effect immediately without needing to reload the page.
  const DEFAULT_SETTINGS = {
    autoSubmitEnabled: true,
    submitDelayMs: 150, // how long to wait after selecting before clicking Submit
    debug: false,
    hideWithPlayerControls: true, // fade with the video player's own controls
    autoOpenPollPanel: true, // proactively click the poll icon if no poll is currently showing
    pacing: "fast", // click timing: "fast" (default) | "careful" (waits a painted frame between steps, like the original) | "exact" (no waits of ours: your delay decides)
    fastMode: false, // legacy on/off switch from 3.6.0 — means "exact" (see pacingMode)
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  function loadSettings() {
    try {
      chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
        if (chrome.runtime.lastError) {
          warn("Couldn't load settings, using defaults.", chrome.runtime.lastError);
          return;
        }
        settings = Object.assign({}, DEFAULT_SETTINGS, result.settings);
        syncSettingsToUI();
        log("Settings loaded:", settings);
      });
    } catch (err) {
      warn("chrome.storage unavailable, using default settings.", err);
    }
  }

  function saveSettingsPatch(patch) {
    settings = Object.assign({}, settings, patch);
    syncSettingsToUI();
    try {
      chrome.storage.local.set({ settings });
    } catch (err) {
      warn("Couldn't persist settings.", err);
    }
  }

  function syncSettingsToUI() {
    if (!dropdownRef) return;
    const toggleEl = dropdownRef.querySelector("#pw-auto-toggle");
    if (toggleEl) toggleEl.checked = settings.autoSubmitEnabled;
  }

  // Stay in sync if the popup changes settings while this page is open.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
      syncSettingsToUI();
      log("Settings updated from popup:", settings);
    });
  } catch (err) {
    warn("Couldn't attach storage change listener.", err);
  }

  // ================= Logging =================
  const PREFIX = "[PW Poll Assist]";
  function log(...args) {
    if (settings.debug) console.log(PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(PREFIX, ...args);
  }
  function logError(context, err) {
    console.error(PREFIX, context, err);
  }

  // ================= State =================
  let selectedOption = null; // "A" | "B" | "C" | "D" | null
  let armedPerf = 0; // same moment on the high-resolution clock (for the timing readout)
  let armedAt = 0; // when selectedOption was last armed (ms epoch) — tells "meant for this poll" from "meant for the next one"
  let answerWrapRef = null;
  let dropdownRef = null;
  let iconRef = null;
  let observer = null;
  let injectPollId = null;
  let trackingRafId = null;
  const scriptStartTime = Date.now();
  let destroyed = false;

  // ================= UI: build pieces =================
  function buildIconWrap() {
    const wrap = document.createElement("div");
    wrap.id = "pw-answer-btn-wrap";
    wrap.innerHTML = `
      <div id="pw-answer-icon" title="Pre-select poll answer" role="button" aria-label="Pre-select poll answer" tabindex="0">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="none" viewBox="0 0 40 40" aria-hidden="true">
          <path fill="#ffffff" d="M20 4C11.163 4 4 11.163 4 20s7.163 16 16 16 16-7.163 16-16S28.837 4 20 4zm-2.2 22.8l-6.6-6.6 2.263-2.263 4.337 4.325 9.337-9.337 2.263 2.275L17.8 26.8z"/>
        </svg>
      </div>
    `;
    document.body.appendChild(wrap);
    return wrap;
  }

  function buildDropdown() {
    const dropdown = document.createElement("div");
    dropdown.id = "pw-answer-dropdown";
    dropdown.setAttribute("role", "dialog");
    dropdown.setAttribute("aria-label", "Poll Assist");
    dropdown.innerHTML = `
      <div class="pw-header">
        <span class="pw-header-title">Poll Assist</span>
      </div>
      <div class="pw-toggle-row">
        <span class="pw-toggle-label">Auto-submit</span>
        <label class="pw-switch">
          <input type="checkbox" id="pw-auto-toggle">
          <span class="pw-switch-track"><span class="pw-switch-thumb"></span></span>
        </label>
      </div>
      <div class="pw-options" role="group" aria-label="Answer options">
        <button type="button" class="pw-opt-btn" data-val="A" aria-pressed="false">A</button>
        <button type="button" class="pw-opt-btn" data-val="B" aria-pressed="false">B</button>
        <button type="button" class="pw-opt-btn" data-val="C" aria-pressed="false">C</button>
        <button type="button" class="pw-opt-btn" data-val="D" aria-pressed="false">D</button>
      </div>
      <div class="pw-status" aria-live="polite">
        <span class="pw-status-icon">●</span>
        <span class="pw-status-text">Pick your answer — it'll be submitted the instant the poll opens.</span>
      </div>
    `;
    document.body.appendChild(dropdown);

    return dropdown;
  }

  function positionDropdown() {
    if (!dropdownRef || !iconRef) return;
    try {
      const rect = iconRef.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dropW = Math.min(190, vw - margin * 2);
      const dropH = dropdownRef.offsetHeight || 170;

      let top = rect.top - dropH - margin;
      if (top < margin) top = rect.bottom + margin;
      top = Math.max(margin, Math.min(top, vh - dropH - margin));

      let left = rect.right - dropW;
      left = Math.max(margin, Math.min(left, vw - dropW - margin));

      dropdownRef.style.width = `${dropW}px`;
      dropdownRef.style.top = `${top}px`;
      dropdownRef.style.left = `${left}px`;
    } catch (err) {
      logError("positionDropdown failed", err);
    }
  }

  function setArmedVisual(isArmed) {
    if (iconRef) iconRef.classList.toggle("pw-armed", !!isArmed);
  }

  function setStatus(text, kind, detail) {
    if (dropdownRef && dropdownRef._pwSetStatus) dropdownRef._pwSetStatus(text, kind, detail);
    log("status:", text);
    if (detail) log("timeline:\n" + detail);
  }

  function wireDropdown(dropdown) {
    const statusTextEl = dropdown.querySelector(".pw-status-text");
    const statusIconEl = dropdown.querySelector(".pw-status-icon");
    const toggleEl = dropdown.querySelector("#pw-auto-toggle");
    toggleEl.checked = settings.autoSubmitEnabled;

    dropdown.querySelectorAll(".pw-opt-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();

        // Clicking the already-selected option deselects it.
        if (selectedOption === btn.dataset.val) {
          selectedOption = null;
          btn.classList.remove("selected");
          btn.setAttribute("aria-pressed", "false");
          dropdown._pwSetStatus("Pick your answer — it'll be submitted the instant the poll opens.", "idle");
          setArmedVisual(false);
          log("Option deselected");
          return;
        }

        selectedOption = btn.dataset.val;
        dropdown.querySelectorAll(".pw-opt-btn").forEach((b) => {
          b.classList.remove("selected");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("selected");
        btn.setAttribute("aria-pressed", "true");
        dropdown._pwSetStatus(`Ready — "${selectedOption}" will be submitted when the poll opens.`, "ready");
        setArmedVisual(true);
        log("Option armed:", selectedOption);
        // If a poll is already running, pick it up right now instead of waiting for the next one.
        onAnswerArmed();
      });
    });

    toggleEl.addEventListener("click", (e) => e.stopPropagation());
    toggleEl.addEventListener("change", () => {
      saveSettingsPatch({ autoSubmitEnabled: toggleEl.checked });
      dropdown._pwSetStatus(
        toggleEl.checked ? "Auto-submit is on." : "Auto-submit is off — you'll need to submit manually.",
        "idle"
      );
      log("Auto-submit set to", toggleEl.checked);
    });

    dropdown.addEventListener("click", (e) => e.stopPropagation());
    dropdown.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dropdown.classList.remove("pw-open");
    });

    // kind: "idle" (default gray) | "ready" (blue) | "success" (green) | "warning" (amber)
    dropdown._pwSetStatus = (text, kind, detail) => {
      statusTextEl.textContent = text;
      // Hovering the status line shows the step-by-step timing (when there is one).
      if (detail) statusTextEl.title = detail;
      else statusTextEl.removeAttribute("title");
      statusIconEl.className = "pw-status-icon" + (kind ? ` pw-status-${kind}` : "");
    };
  }

  function resetSelectionAfterPoll() {
    selectedOption = null;
    armedAt = 0;
    armedPerf = 0;
    setArmedVisual(false);
    if (dropdownRef) {
      dropdownRef.querySelectorAll(".pw-opt-btn").forEach((b) => {
        b.classList.remove("selected");
        b.setAttribute("aria-pressed", "false");
      });
    }
  }

  // ================= Button creation (independent of site's DOM tree) =================
  function ensureButtonExists() {
    if (answerWrapRef && document.body.contains(answerWrapRef)) return;

    let dropdown = document.getElementById("pw-answer-dropdown");
    if (!dropdown) {
      dropdown = buildDropdown();
      wireDropdown(dropdown);
    }

    const wrap = buildIconWrap();
    const icon = wrap.querySelector("#pw-answer-icon");
    iconRef = icon; // set before setArmedVisual() below, which reads iconRef
    setArmedVisual(!!selectedOption);
    wrap.addEventListener("mouseenter", markActivity);
    dropdown.addEventListener("mouseenter", markActivity);
    dropdown.addEventListener("mousemove", markActivity);

    const toggleDropdown = (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains("pw-open");
      if (isOpen) {
        dropdown.classList.remove("pw-open");
      } else {
        dropdown.classList.add("pw-open");
        positionDropdown();
      }
    };
    icon.addEventListener("click", toggleDropdown);
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // stop Space from also scrolling the page
        toggleDropdown(e);
      }
    });

    answerWrapRef = wrap;
    dropdownRef = dropdown;
  }

  // ================= Activity-based visibility =================
  // Own timer, not the site's internal CSS classes. Earlier versions
  // tried to mirror Video.js's own `vjs-user-active` /
  // `vjs-user-inactive` classes, but that proved unreliable — this site's
  // player didn't reliably transition back to "active" the way we
  // expected, leaving the button stuck hidden. Instead, we track real
  // mouse movement ourselves (over the player area, or over our own
  // button/dropdown) and fade out after a period of inactivity — the same
  // UX pattern video players use, driven by activity we can directly
  // observe rather than internal class names we have to guess at.
  const INACTIVITY_HIDE_MS = 3000; // matches the ~3s idle timeout most video players use
  let lastActivityAt = Date.now();

  let cachedPlayerRoot = null;
  function getPlayerRoot() {
    if (cachedPlayerRoot && document.body.contains(cachedPlayerRoot)) {
      return cachedPlayerRoot;
    }
    try {
      const anchor = document.querySelector(".vjs-current-time, .vjs-duration, .vjs-control-bar");
      const root =
        (anchor && anchor.closest(".video-js")) ||
        document.querySelector(".video-js") ||
        document.getElementById("video-player-container") ||
        document.querySelector(".video-player-app");
      cachedPlayerRoot = root || null;
    } catch (err) {
      logError("getPlayerRoot failed", err);
      cachedPlayerRoot = null;
    }
    return cachedPlayerRoot;
  }

  function markActivity() {
    lastActivityAt = Date.now();
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      const root = getPlayerRoot();
      if (!root) {
        // No player detected at all — any movement counts as activity so
        // the button doesn't get stuck hidden on pages without one.
        markActivity();
        return;
      }
      const rect = root.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        markActivity();
        return;
      }
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        markActivity();
      }
    },
    { passive: true }
  );

  function shouldShowButton() {
    if (!settings.hideWithPlayerControls) return true;
    if (dropdownRef && dropdownRef.classList.contains("pw-open")) return true; // never hide mid-use
    return Date.now() - lastActivityAt < INACTIVITY_HIDE_MS;
  }
  // Runs every animation frame: finds the real poll icon (if any) and
  // pins our button beside it. Recorded classes (no #poll-icon at all)
  // are handled entirely in tick() — the button is never created there,
  // so this only ever needs to handle the live-class case.
  function trackPosition() {
    if (destroyed) return;
    try {
      if (answerWrapRef && document.body.contains(answerWrapRef)) {
        const visible = shouldShowButton();
        answerWrapRef.classList.toggle("pw-hidden", !visible);
        if (!visible && dropdownRef) dropdownRef.classList.remove("pw-open");

        const pollIcon = document.querySelector("#poll-icon");
        if (pollIcon) {
          const rect = pollIcon.getBoundingClientRect();
          // Only reposition if the icon is actually visible/laid out
          // (rect.width === 0 usually means display:none / not rendered).
          if (rect.width > 0 && rect.height > 0) {
            const left = rect.left - CONFIG.ICON_SIZE - CONFIG.DOCK_GAP;
            answerWrapRef.style.position = "fixed";
            answerWrapRef.style.top = `${rect.top}px`;
            answerWrapRef.style.left = `${Math.max(4, left)}px`;
          }
        }
        if (dropdownRef && dropdownRef.classList.contains("pw-open")) {
          positionDropdown();
        }
      }
    } catch (err) {
      logError("trackPosition failed", err);
    }
    trackingRafId = requestAnimationFrame(trackPosition);
  }

  // ================= Global UI event wiring (once) =================
  document.addEventListener("click", (e) => {
    // Ignore the clicks this script makes itself (poll icon / option / submit) —
    // otherwise every auto-open would slam the panel shut while you're using it.
    if (!e.isTrusted) return;
    if (!dropdownRef) return;
    if (answerWrapRef && answerWrapRef.contains(e.target)) return;
    if (dropdownRef.contains(e.target)) return;
    dropdownRef.classList.remove("pw-open");
  });

  window.addEventListener("resize", () => {
    if (dropdownRef && dropdownRef.classList.contains("pw-open")) positionDropdown();
  });

  // ================= Poll detection =================
  // Only a *visible* match counts. A closed panel that the site keeps
  // mounted (display:none) is not "an open poll" — treating it as one made
  // the old code believe the panel was open and skip opening it.
  function isVisible(el) {
    try {
      return !!el && el.isConnected && el.getClientRects().length > 0;
    } catch (_e) {
      return false;
    }
  }

  function isOwnUi(el) {
    return !!((dropdownRef && dropdownRef.contains(el)) || (answerWrapRef && answerWrapRef.contains(el)));
  }

  function containsPollHeading(node) {
    const spans = node.querySelectorAll("span");
    for (const sp of spans) {
      const t = sp.textContent;
      if (t && t.toLowerCase().includes(CONFIG.POLL_HEADING_MATCH)) return true;
    }
    return false;
  }

  // The poll UI = the smallest element holding both the heading ("... Choice
  // Poll") and its radio inputs. Starting from the radios makes the common
  // case (no poll on screen) a single cheap query instead of a scan of every
  // <span> on the page.
  function findPollContainer() {
    try {
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios.length === 0) return null;
      for (const radio of radios) {
        let node = radio.parentElement;
        for (let i = 0; i < 12 && node && node !== document.body; i++, node = node.parentElement) {
          if (containsPollHeading(node)) {
            if (isVisible(node)) return node;
            break; // heading found, but this poll UI is hidden — try the next radio
          }
        }
      }
    } catch (err) {
      logError("findPollContainer failed", err);
    }
    return null;
  }

  // A short text fingerprint of the poll UI, used to tell "the previous
  // poll's leftover UI" apart from "the new poll's UI" (see isLeftoverUi).
  function uiSignature(node, normaliseDigits) {
    try {
      let text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (normaliseDigits) text = text.replace(/\d+/g, "#");
      let sig = text.slice(0, 400);
      // Text alone isn't enough: consecutive polls often have identical text
      // (just "A B C D"). What tells a fresh UI from a used one is its
      // *state* — enabled vs disabled, selected vs not.
      let n = 0;
      for (const el of node.querySelectorAll("button, input")) {
        if (++n > 40) break;
        const selected =
          el.checked === true ||
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("aria-checked") === "true" ||
          el.getAttribute("aria-selected") === "true";
        sig += (el.disabled || el.getAttribute("aria-disabled") === "true" ? "|d" : "|e") + (selected ? "s" : "-");
      }
      return sig;
    } catch (_e) {
      return "";
    }
  }

  // Re-scanning the DOM every frame is wasteful; rescan when the DOM changed
  // (MutationObserver sets domDirty) or every SCAN_INTERVAL_MS otherwise
  // (covers pure style changes, e.g. display:none -> block, that don't
  // add/remove nodes).
  let domDirty = true;
  let scanCache = { at: 0, node: null };
  function currentPollContainer() {
    const now = Date.now();
    const cached = scanCache.node;
    if (!domDirty && now - scanCache.at < CONFIG.SCAN_INTERVAL_MS && (!cached || isVisible(cached))) {
      return cached;
    }
    scanCache = { at: now, node: findPollContainer() };
    domDirty = false;
    return scanCache.node;
  }

  function isOptionButton(btn, letter) {
    const want = letter ? letter.toUpperCase() : null;
    for (const s of btn.querySelectorAll("span")) {
      const t = s.textContent && s.textContent.trim().toUpperCase();
      if (!t) continue;
      if (want ? t === want : /^[A-D]$/.test(t)) return true;
    }
    return false;
  }

  // true / false when the page reports whether this option is selected, null
  // when it doesn't say (so we never guess).
  function isOptionSelected(btn) {
    try {
      const radio = btn.querySelector('input[type="radio"]');
      if (radio) return !!radio.checked;
      for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
        const v = btn.getAttribute(attr);
        if (v === "true") return true;
        if (v === "false") return false;
      }
    } catch (_e) {
      // fall through
    }
    return null;
  }

  function findMatchingOptionButton(container, letter) {
    if (!container || !letter) return null;
    try {
      for (const btn of container.querySelectorAll("button")) {
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
        if (isOptionButton(btn, letter)) return btn;
      }
    } catch (err) {
      logError("findMatchingOptionButton failed", err);
    }
    return null;
  }

  function hasOptionButtons(container) {
    try {
      for (const btn of container.querySelectorAll("button")) {
        if (!btn.disabled && isOptionButton(btn, null)) return true;
      }
    } catch (err) {
      logError("hasOptionButtons failed", err);
    }
    return false;
  }

  // The Submit button has been observed outside the poll's own subtree, so
  // it can't be looked up strictly inside the container — but "the first
  // button on the whole page containing 'submit'" also picks up unrelated
  // ones ("Submit feedback", a doubt/rating form, ...). So: the closest
  // scope around the poll wins, an exact "Submit" beats a longer label, and
  // far-away buttons are only accepted when the label is exactly "Submit".
  // Without the poll on screen there is nothing to anchor to, so no guess is
  // made at all — a wrong click on some unrelated Submit is worse than a
  // clear "couldn't find Submit" warning.
  function findSubmitButton(container) {
    if (!container) return null;
    try {
      const cands = [];
      for (const b of document.querySelectorAll("button")) {
        if (isOwnUi(b)) continue;
        const t = (b.textContent || "").trim().toLowerCase();
        if (!t.includes("submit") || !isVisible(b)) continue;
        cands.push({ b, rank: t === "submit" ? 0 : t.startsWith("submit") ? 1 : 2 });
      }
      if (cands.length === 0) return null;

      let scope = container;
      for (let i = 0; i < 6 && scope && scope !== document.body; i++, scope = scope.parentElement) {
        const inScope = cands.filter((c) => scope.contains(c.b));
        if (inScope.length) return inScope.reduce((best, c) => (c.rank < best.rank ? c : best)).b;
      }
      const exact = cands.filter((c) => c.rank === 0);
      return exact.length ? exact[0].b : null;
    } catch (err) {
      logError("findSubmitButton failed", err);
    }
    return null;
  }

  // Does this look like a poll you can vote in right now (as opposed to a
  // results / "answer recorded" view that reuses the same heading)?
  function looksLikeLiveVote(container) {
    return hasOptionButtons(container) && !!findSubmitButton(container);
  }

  // ================= Scheduling =================
  // requestAnimationFrame never fires in a background tab, and a live class
  // is very often left in one. Every time-critical step therefore also has a
  // timer fallback (timers keep running, just throttled) — whichever fires
  // first runs the callback, the other is a no-op.
  function nextFrame(fn) {
    let fired = false;
    let timer = 0;
    const run = () => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      fn();
    };
    requestAnimationFrame(run);
    timer = setTimeout(run, CONFIG.BACKGROUND_TICK_MS);
  }

  // Lets the site's own already-queued work run first. When a poll event
  // arrives, our handler runs BEFORE the site has rendered what it just
  // received (the hook's message is queued ahead of the site's own render),
  // so "no poll UI on screen yet" at that instant does not mean the panel is
  // closed. One task later it usually does — and that is a few milliseconds,
  // not a timer: it is the only thing standing between "poll event" and
  // "click", and it is what stops us toggling an already-open panel shut.
  function afterSiteTask(fn, light) {
    const finish = () => {
      // In a hidden tab timers are throttled to ~1s, so skip the 2nd hop there
      // (and `light` callers only ever want the single message-task hop).
      if (light || document.hidden) fn();
      else setTimeout(fn, 0);
    };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        finish();
      };
      ch.port2.postMessage(0);
    } catch (_e) {
      finish();
    }
  }

  // ================= Poll session =================
  // Everything that happens for one poll — opening the panel, waiting for
  // its UI, selecting, submitting — lives in ONE session object driven by
  // ONE loop (superviseSession). That's deliberate: the site's poll icon is
  // a *toggle*, and the old code had two independent code paths that could
  // each click it (the WebSocket "start" event and the icon-color change).
  // When both fired, or when either fired while the panel was already open,
  // the net effect was closing the panel. Now there is exactly one place
  // that ever clicks it (maybeOpenPanel), with rate limits.
  let session = null;
  let lastUiMark = null; // { node, sig } — the last poll UI we saw
  let lastEndedAt = 0; // when the previous session ended
  let lastIconClickAt = 0;
  let sessionSeq = 0;
  const handledPollStartIds = new Set();

  // High-resolution clock for the timing readout: Date.now() is whole
  // milliseconds, too coarse to show a ~1 ms step.
  function tnow() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function fmtMs(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
    return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  }

  function beginSession({ id, meta, source, viaArm }) {
    if (destroyed) return null;
    const now = Date.now();
    const durationMs = meta && typeof meta.durationMs === "number" ? meta.durationMs : CONFIG.UNKNOWN_POLL_WINDOW_MS;

    if (session && session.state === "live" && now - session.startedAt < CONFIG.SIGNAL_MERGE_MS) {
      // The icon's color change and the WebSocket "start" frame describe the
      // same poll and land within milliseconds of each other, in either
      // order. Fold them into one session so the panel is only opened once.
      if (source === "ws" && session.source !== "ws") {
        session.id = id;
        session.source = "ws";
        session.meta = meta;
        session.deadlineAt = now + durationMs;
        log("Poll session upgraded with WebSocket details:", id);
        return session;
      }
      if (source !== "ws") return session;
    }

    if (session && session.state === "live") endSession(session, "superseded");

    const s = {
      id,
      source, // "ws" | "icon" | "dom"
      meta, // { pollId, options, durationMs } from the WebSocket, or null
      startedAt: now,
      // Deliberately measured from *when we received the event*, not from the
      // payload's pollStartTime: that timestamp is on the server's clock, and
      // a PC clock that's even a little ahead made every poll look "already
      // expired" and got it skipped.
      deadlineAt: now + durationMs,
      state: "live",
      answered: false,
      clicks: 0, // times WE clicked the poll icon for this poll
      lastClickAt: 0,
      userToggled: false, // the user clicked the icon themselves — stop touching it
      attempt: null,
      warnedUnarmed: false,
      staleMark: lastUiMark, // what the poll UI looked like BEFORE this poll
      settled: false, // true once the site has had one task to render what it just received
      t0: tnow(), // when we learned of the poll (hi-res clock) — the zero point of the timing readout
      viaArm: !!viaArm, // started because the user armed an answer while the poll UI was already up
      submitCheck: null, // set once Submit has been clicked: are we seeing the page accept it?
      pageErrors: [], // error messages the PAGE showed while we were acting (PW.live's own, e.g. "Unauthorised Scope Access")
      errorObserver: null,
    };
    session = s;
    log("Poll session started:", id, `(${source})`);
    // If a poll UI is already showing, we act on it immediately (below). Only
    // the decision to CLICK the toggle icon waits for this one-task yield.
    afterSiteTask(() => {
      s.settled = true;
      if (session === s && s.state === "live") superviseSession();
    });
    kickSupervisor();
    return s;
  }

  function endSession(s, reason) {
    if (!s || s.state === "ended") return;
    s.state = "ended";
    stopPageErrorWatch(s);
    dropAttempt(s);
    if (s.submitCheck && !s.submitCheck.done) {
      // Only speak up if the poll simply ran out; if a new poll took over, its
      // own statuses are about to replace this one anyway.
      if (reason === "expired") evaluateSubmitCheck(s, currentPollContainer(), Date.now());
      else finishSubmitCheck(s, null, true);
    }
    lastEndedAt = Date.now();
    noteUi(currentPollContainer(), true);
    if (reason === "expired" && !s.answered && selectedOption && armedAt <= s.deadlineAt) {
      // The armed answer was meant for this poll and the poll is over. Don't
      // leave it armed to fire on some later, unrelated poll. (An answer armed
      // AFTER the deadline is for the next poll, so it's left alone.)
      setStatus("The poll ended before your answer could be submitted.", "warning");
      resetSelectionAfterPoll();
    }
    log("Poll session ended:", s.id, `(${reason})`);
  }

  let supervisorRunning = false;
  function kickSupervisor() {
    if (supervisorRunning) return;
    supervisorRunning = true;
    const step = () => {
      if (destroyed || !session || session.state === "ended") {
        supervisorRunning = false;
        return;
      }
      try {
        superviseSession();
      } catch (err) {
        logError("superviseSession failed", err);
      }
      if (!session || session.state === "ended") supervisorRunning = false;
      else if (session.answered && !(session.submitCheck && !session.submitCheck.done)) setTimeout(step, 250); // just watching the UI settle now
      else nextFrame(step);
    };
    step();
  }

  // Remember what the poll UI currently looks like, so the next poll can
  // tell a leftover copy of this one from its own fresh UI.
  let notedAt = 0;
  function noteUi(container, force) {
    // Fingerprinting the UI isn't free; a few times a second is plenty (and the
    // final state is always recorded when a session ends — see endSession).
    const t = Date.now();
    if (!force && t - notedAt < 100) return;
    notedAt = t;
    // Always a NEW object: a session's staleMark is a snapshot of an earlier
    // lastUiMark and must never change underneath it.
    if (container) {
      lastUiMark = { node: container, sig: uiSignature(container) };
    } else if (lastUiMark && lastUiMark.node.isConnected) {
      // The node is still there but is no longer a poll (results / "answer
      // recorded"): remember what it looks like *now*, so a later poll
      // rendered into the same node is recognised as new.
      lastUiMark = { node: lastUiMark.node, sig: uiSignature(lastUiMark.node) };
    }
  }

  // True while the poll UI on screen is still (an unchanged copy of) the
  // previous poll's. Acting on it would select/submit into a poll that has
  // already ended.
  function isLeftoverUi(s, container, now) {
    const m = s.staleMark;
    if (!m || now - s.startedAt >= CONFIG.STALE_UI_TIMEOUT_MS) return false;
    return container === m.node && uiSignature(container) === m.sig;
  }

  function clickPollIcon(reason) {
    try {
      const icon = document.querySelector("#poll-icon");
      if (!icon) return false;
      lastIconClickAt = Date.now();
      icon.click();
      log("Clicked poll icon —", reason);
      return true;
    } catch (err) {
      logError("clickPollIcon failed", err);
      return false;
    }
  }

  // The ONLY place the poll icon gets clicked automatically. Called only
  // when no poll UI is visible.
  function maybeOpenPanel(s, now) {
    if (!settings.autoOpenPollPanel) return;
    if (s.userToggled) return; // the user is driving the panel — don't fight them
    if (s.clicks >= CONFIG.MAX_OPEN_CLICKS) return;

    if (s.clicks === 0) {
      if (!s.settled) return; // one browser task — see afterSiteTask
      // If the PREVIOUS poll's UI is still on screen, the panel is open: it is
      // about to be swapped for the new poll (we then act on it with no click
      // at all) or the site is about to close it (we then click the moment it
      // has gone). Either way clicking now would toggle it shut, so we watch
      // the screen instead of a clock. The cap only stops a panel that is
      // permanently static from blocking us forever.
      const oldUiStillShowing = !!(s.staleMark && isVisible(s.staleMark.node));
      if (oldUiStillShowing && now - s.startedAt < CONFIG.OPEN_HOLD_MS) return;
    } else {
      // A second click is a toggle back — it only makes sense if the first
      // one evidently didn't produce the poll, and only when an armed
      // answer is actually waiting on it.
      if (!selectedOption) return;
      const opts = s.meta && Array.isArray(s.meta.options) && s.meta.options.length > 0 ? s.meta.options : null;
      if (opts && !opts.includes(selectedOption.toUpperCase())) return; // not answerable — don't close a panel the user may want
      if (now - s.lastClickAt < CONFIG.OPEN_VERIFY_MS) return;
    }
    if (now - lastIconClickAt < CONFIG.AUTO_OPEN_RETRY_MS) return; // hard floor, across every path

    if (clickPollIcon(s.clicks === 0 ? `poll ${s.id} started, panel not showing it` : `retry — panel still not showing poll ${s.id}`)) {
      s.clicks++;
      s.lastClickAt = now;
    }
  }

  function warnUnarmedOnce(s) {
    if (s.warnedUnarmed) return;
    s.warnedUnarmed = true;
    setStatus("Poll detected, but no option was pre-selected!", "warning");
    warn("Poll appeared with no pre-selected option.");
  }

  // One step of the loop that drives the current poll.
  function superviseSession() {
    const s = session;
    if (!s || s.state === "ended") return;
    const now = Date.now();
    if (now > s.deadlineAt + CONFIG.POLL_END_GRACE_MS) {
      endSession(s, "expired");
      return;
    }

    const container = currentPollContainer();
    noteUi(container);
    if (s.answered) {
      if (s.submitCheck && !s.submitCheck.done) evaluateSubmitCheck(s, container, now);
      return; // nothing left to do for this poll
    }

    if (now > s.deadlineAt) {
      // The poll's window is over. The grace period exists so an attempt
      // that's already in flight can finish or fail cleanly, and so we can
      // watch the site swap its UI (which lets the next poll tell this one's
      // leftovers from its own) — never to start new work on a dead poll.
      if (s.attempt) advanceAttempt(s, container, now);
      return;
    }

    if (s.attempt) {
      advanceAttempt(s, container, now);
      return;
    }
    if (container) {
      if (isLeftoverUi(s, container, now)) return; // wait for the site to swap in the new poll
      noteSettle(s, container);
      if (!selectedOption) {
        warnUnarmedOnce(s);
        return;
      }
      if (!uiSettled(s, container)) return; // the page is still finishing drawing this poll
      beginAttempt(s, container, now);
      return;
    }
    maybeOpenPanel(s, now);
  }

  // ================= Pacing =================
  // A page needs a moment AFTER it draws the poll before it will take a click
  // (its own post-render work: effects, loading your permissions/"scope"...).
  // A click that lands in the same instant the poll appears can be rejected —
  // the page shows an error and the option never gets marked. The original
  // extension never ran into this because it always acted at least a frame
  // later. So by default we wait for ONE painted frame, one more task, and a
  // small floor (PACE_MS) after the poll UI first appears. Fast mode skips it.
  // Click timing. "fast" (default): act the moment the poll is on screen and
  // send Submit MIN_SUBMIT_GAP_MS after the option click — the least PW.live
  // accepts. "careful": also wait a painted frame (+ a floor) before the first
  // click and before Submit, like the original did. "exact": no waits of our own;
  // the user's "Delay before submitting" alone decides. (`fastMode` is the old
  // 3.6.0 switch and means "exact"; old names "safe"/"frame"/"instant" still work.)
  function pacingMode() {
    const alias = { safe: "careful", frame: "fast", instant: "exact" };
    let p = alias[settings.pacing] || settings.pacing;
    if (p !== "fast" && p !== "careful" && p !== "exact") p = "fast";
    if (p === "fast" && settings.fastMode) p = "exact";
    return p;
  }

  // Grows (only ever within a page session) when PW refuses a Submit even after
  // MIN_SUBMIT_GAP_MS, so the NEXT polls wait longer. Not saved anywhere.
  let learnedSubmitGapMs = 0;

  function noteSettle(s, container) {
    const mode = pacingMode();
    if (mode !== "careful" || s.settleNode === container) return;
    s.settleNode = container;
    s.settledNode = null;
    const seenAt = tnow();
    const floor = CONFIG.PACE_MS;
    const finish = () => {
      if (session !== s || s.state !== "live" || s.settleNode !== container) return;
      s.settledNode = container;
      superviseSession();
    };
    nextFrame(() =>
      afterSiteTask(() => {
        const wait = floor - (tnow() - seenAt);
        if (wait > 0) setTimeout(finish, wait);
        else finish();
      }, true)
    );
  }

  function uiSettled(s, container) {
    return pacingMode() !== "careful" || s.settledNode === container;
  }

  // ================= Selecting + submitting =================
  function beginAttempt(s, container, now) {
    const letter = selectedOption;
    s.warnedUnarmed = true; // from here on the status line belongs to this attempt's outcome

    // The WebSocket payload is the site's own authoritative data: if the
    // armed answer isn't one of this poll's options, don't waste time
    // searching the DOM for something that can't exist.
    const opts = s.meta && Array.isArray(s.meta.options) && s.meta.options.length > 0 ? s.meta.options : null;
    if (opts && !opts.includes(letter.toUpperCase())) {
      setStatus(`Armed answer "${letter}" isn't one of this poll's options (${opts.join(", ")}).`, "warning");
      warn(`Selected option "${letter}" isn't in this poll's real option list:`, opts);
      resetSelectionAfterPoll();
      return;
    }

    s.attempt = {
      letter,
      phase: "select", // select -> confirm -> delay -> submit
      startedAt: now,
      optionBtn: null,
      selectedAt: 0,
      delayMs: 0,
      submitStartedAt: 0,
      submitTimeoutMs: 0,
      reselects: 0,
      sawSelected: false, // the page has shown our option as selected at least once
      clickedAt: 0, // when we last clicked the option
      tries: 0, // option clicks so far
      sigBefore: "", // option list state just before the last click
      submitWasDisabled: false,
      replaced: false, // the page rebuilt the option element after our click
      hopStarted: false,
      hopDone: false,
      optionObserver: null,
      armedPerf, // when the answer was picked
      tBegin: tnow(), // poll UI on screen and an answer waiting for it
      tSelected: 0, // option clicked
      tMarked: 0, // page registered it
      lostAt: 0,
      delayTimer: 0,
      tFirstDone: 0, // first option click delivered
      tLastDone: 0, // latest option click delivered
      userDelayMs: 0,
      floorMs: 0,
    };
    log(`Attempting "${letter}" on poll ${s.id}.`);
    advanceAttempt(s, container, now);
  }

  // The page processes a click a moment AFTER the click handler returns (React
  // and friends commit the new state in a later task). A Submit that lands
  // before that goes out with no option selected — so after clicking the
  // option we watch for the page's reaction (see "confirm" in advanceAttempt).
  function stopOptionWatch(a) {
    if (a && a.optionObserver) {
      a.optionObserver.disconnect();
      a.optionObserver = null;
    }
  }

  function dropAttempt(s) {
    if (s && s.attempt) {
      stopOptionWatch(s.attempt);
      if (s.attempt.delayTimer) clearTimeout(s.attempt.delayTimer);
    }
    if (s) s.attempt = null;
  }

  function watchOptionReaction(s, a, btn) {
    stopOptionWatch(a);
    try {
      // Only a wake-up call: re-check the evidence the moment the option list
      // changes, rather than on the next frame.
      const mo = new MutationObserver(() => {
        if (session === s && s.attempt === a) superviseSession();
      });
      const root = btn.closest('[role="radiogroup"], [role="listbox"], [role="group"]') || btn.parentElement || btn;
      mo.observe(root, { attributes: true, childList: true, subtree: true, characterData: true });
      a.optionObserver = mo;
    } catch (err) {
      logError("watchOptionReaction failed", err);
    }
  }

  function clickOption(s, a, btn, now) {
    a.optionBtn = btn;
    a.clickedAt = now;
    a.tries = (a.tries || 0) + 1;
    if (!a.selectedAt) a.selectedAt = now; // the delay you set counts from the FIRST selection
    if (!a.tSelected) a.tSelected = tnow();
    a.hopStarted = false;
    a.hopDone = false;
    a.sawSelected = false;
    a.replaced = false;
    // What the option list and Submit look like BEFORE the click, so a change
    // afterwards is evidence the page took it.
    a.sigBefore = optionListSig(btn);
    const sb0 = findSubmitButton(currentPollContainer());
    a.submitWasDisabled = !!sb0 && (sb0.disabled || sb0.getAttribute("aria-disabled") === "true");
    watchPageErrors(s);
    watchOptionReaction(s, a, btn); // before the click, so a synchronous reaction is caught too
    btn.click();
    // The clocks for the delay and for PW.live's minimum gap start NOW, once the
    // click has really been delivered (not just before it).
    a.tLastDone = tnow();
    if (!a.tFirstDone) a.tFirstDone = a.tLastDone;
    // Pages that react without touching the DOM (e.g. only a radio's `checked`)
    // never trigger the observer — look again one task later.
    afterSiteTask(() => {
      if (session === s && s.attempt === a) superviseSession();
    }, true);
  }

  // A fingerprint of the option list's STATE: structure, classes, aria/
  // checked/disabled flags, text length (digits normalised). It changes when the
  // page marks (or unmarks) an option, and is deliberately blind to a ticking
  // countdown elsewhere on the poll.
  function optionListSig(btn) {
    try {
      const root = btn.closest('[role="radiogroup"], [role="listbox"], [role="group"]') || btn.parentElement || btn;
      let sig = "";
      let n = 0;
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (++n > 120) break;
        sig +=
          el.tagName + "." + (el.getAttribute("class") || "") + "|" +
          (el.getAttribute("aria-pressed") || "") + (el.getAttribute("aria-checked") || "") + (el.getAttribute("aria-selected") || "") +
          (el.disabled ? "d" : "") + (el.checked ? "c" : "") + ";";
      }
      return sig + "#" + (root.textContent || "").replace(/\s+/g, " ").replace(/\d+/g, "#").length;
    } catch (_e) {
      return "";
    }
  }

  // Did the page take our option click? Any ONE of: it says the option is
  // selected; it rebuilt the option list; the option list's state visibly
  // changed; Submit went from disabled to enabled.
  function optionMarkedEvidence(a, container) {
    if (isOptionSelected(a.optionBtn) === true) return "the page reports the option selected";
    if (a.replaced) return "the page rebuilt the option list";
    if (optionListSig(a.optionBtn) !== a.sigBefore) return "the option list changed";
    if (a.submitWasDisabled) {
      const sb = findSubmitButton(container);
      if (sb && !sb.disabled && sb.getAttribute("aria-disabled") !== "true") return "Submit became enabled";
    }
    return null;
  }

  function markAlreadySelected(a, btn, now) {
    a.optionBtn = btn;
    a.clickedAt = now;
    if (!a.selectedAt) a.selectedAt = now;
    if (!a.tSelected) a.tSelected = tnow();
    if (!a.tMarked) a.tMarked = tnow();
    a.tFirstDone = a.tFirstDone || tnow(); // your delay counts from now...
    a.tLastDone = tnow() - 1000; // ...but the page took this selection long ago, so no minimum gap is owed
    a.sawSelected = true;
  }

  function failAttempt(s, statusText, warnText) {
    setStatus(statusText, "warning");
    warn(warnText);
    // Clear the armed answer rather than leaving it to silently fire on some
    // later, unrelated poll if the user forgets to re-pick.
    resetSelectionAfterPoll();
    dropAttempt(s);
  }

  function advanceAttempt(s, container, now) {
    const a = s.attempt;
    if (!a) return;

    // The user changed their mind while we were waiting (the submit delay
    // can be up to a minute): honour the *current* choice, never a stale one.
    if (!selectedOption) {
      dropAttempt(s);
      setStatus("Answer cleared — nothing was submitted.", "idle");
      log("Armed answer was cleared mid-attempt; aborting.");
      return;
    }
    if (selectedOption !== a.letter) {
      dropAttempt(s); // the loop starts a fresh attempt with the new letter
      log(`Armed answer changed ${a.letter} -> ${selectedOption} mid-attempt; restarting.`);
      return;
    }

    const remainingMs = s.deadlineAt - now;
    if (remainingMs <= 0) {
      failAttempt(s, "This poll has already ended — not attempting to submit.", "Poll window has passed; skipping.");
      return;
    }
    const usableMs = Math.max(0, remainingMs - CONFIG.SUBMIT_SAFETY_MARGIN_MS);

    if (!container) {
      // The poll UI is gone (panel closed, site swapped it out, or you
      // submitted by hand). Give it a moment to come back before giving up.
      if (!a.lostAt) a.lostAt = now;
      if (now - a.lostAt >= CONFIG.SUBMIT_TIMEOUT_MS) {
        failAttempt(s, "The poll closed before your answer could be submitted.", "Poll UI disappeared mid-attempt.");
      }
      return;
    }
    if (a.lostAt) {
      a.lostAt = 0;
      a.startedAt = now; // it's back: restart the "wait for the option to render" clock
    }

    if (a.phase === "select") {
      const btn = findMatchingOptionButton(container, a.letter);
      if (!btn) {
        if (now - a.startedAt >= CONFIG.OPTION_FIND_TIMEOUT_MS) {
          failAttempt(
            s,
            `Poll detected, but option "${a.letter}" wasn't found.`,
            `Option "${a.letter}" not found in poll markup — site layout may have changed.`
          );
        }
        return;
      }
      if (isOptionSelected(btn) === true) {
        // Already marked (by the page, or by you): clicking it again could
        // UNSELECT it on a toggle-style option, so leave it alone.
        log(`Option "${a.letter}" is already selected; not clicking it again.`);
        markAlreadySelected(a, btn, now);
      } else {
        clickOption(s, a, btn, now);
      }
      setStatus(`Selected "${a.letter}".`, "ready");

      if (!settings.autoSubmitEnabled) {
        log("Auto-submit is off; leaving submission to the user.");
        const tm = timingBase(s, a);
        setStatus(`Selected "${a.letter}" ${fmtMs(a.tSelected - tm.base)} ${tm.since}. Submitting is up to you.`, "ready");
        resetSelectionAfterPoll(); // one-shot, exactly like a submitted answer
        dropAttempt(s);
        return;
      }
      // Shorten the configured delay if it would run past the poll's real window.
      // ("fast" keeps at least MIN_SUBMIT_GAP_MS between the option click and
      // Submit because PW.live refuses a sooner one; "careful" keeps a frame;
      // "exact" keeps nothing. A longer delay you set always wins.)
      const mode = pacingMode();
      const floor = mode === "careful" ? CONFIG.PACE_SUBMIT_MS : mode === "fast" ? Math.max(CONFIG.MIN_SUBMIT_GAP_MS, learnedSubmitGapMs) : 0;
      a.userDelayMs = Math.min(settings.submitDelayMs, usableMs); // counted from the FIRST click
      a.floorMs = Math.min(floor, usableMs); // counted from the LATEST click (the page only has to accept that one)
      a.delayMs = Math.max(a.userDelayMs, a.floorMs); // the effective gap, for the readout
      a.phase = a.tMarked ? "delay" : "confirm"; // already selected -> nothing to wait for
      return; // otherwise Submit must wait for the page to register the option — see below
    }

    // If the site rebuilt the option list and replaced the element we clicked,
    // follow the new one. Do NOT click again: a second click on a rebuilt (and
    // possibly toggle-style) option could UNSELECT it, and would hand the page a
    // second selection for no reason.
    if (a.optionBtn && !a.optionBtn.isConnected) {
      const fresh = findMatchingOptionButton(container, a.letter);
      if (!fresh) return; // mid-rebuild — look again next step
      a.optionBtn = fresh;
      a.replaced = true; // the page rebuilt it in response to our click: that's a reaction
    }

    // The page can reset the selection under us (a re-render, a repeated
    // event). If we saw our option selected and it no longer is, select it
    // again — the delay you set keeps counting from the FIRST selection.
    // Only when the page really reports selection state, so a UI that
    // doesn't can never be toggled off by a needless second click.
    const sel = isOptionSelected(a.optionBtn);
    if (sel === true) {
      a.sawSelected = true;
    } else if (sel === false && a.sawSelected) {
      if (++a.reselects > 3) {
        failAttempt(s, `Selected "${a.letter}", but the poll kept resetting it.`, "Selection kept being reset by the page.");
        return;
      }
      log("The page reset the selection; selecting again.");
      clickOption(s, a, a.optionBtn, now);
      a.phase = "confirm";
      return;
    }

    if (a.phase === "confirm") {
      // Don't click Submit until the page has MARKED the option. Evidence is the
      // page saying so, the option list visibly changing, or Submit becoming
      // enabled — event-driven, with no timer on the way in.
      const why = optionMarkedEvidence(a, container);
      if (why) {
        if (!a.hopStarted) {
          a.hopStarted = true;
          const settle = () =>
            afterSiteTask(() => {
              a.hopDone = true;
              if (session === s && s.attempt === a) superviseSession();
            }, true);
          // Default mode lets the page paint and finish its post-click work first
          // (a frame), as the original did; fast mode only yields one task.
          if (pacingMode() === "careful") nextFrame(settle);
          else settle();
        }
        if (!a.hopDone) return;
        stopOptionWatch(a);
        if (!a.tMarked) a.tMarked = tnow();
        a.phase = "delay";
      } else {
        const refused = a.pageErrorAt && a.pageErrorAt >= a.clickedAt;
        const retryAfter = refused ? CONFIG.OPTION_RETRY_AFTER_ERROR_MS * a.tries : CONFIG.OPTION_RETRY_MS;
        if (now - a.clickedAt >= retryAfter) {
          // No sign the page took the click — maybe it wasn't ready. Nothing is
          // selected, so clicking again is safe. Never submit an empty answer.
          if (a.tries >= CONFIG.OPTION_MAX_TRIES) {
            failAttempt(s, `Clicked "${a.letter}", but the page never marked it — so Submit was not clicked.`, "No sign that the page registered the option click.");
            return;
          }
          log(`No sign the page took the click on "${a.letter}"; clicking again (try ${a.tries + 1} of ${CONFIG.OPTION_MAX_TRIES}).`);
          clickOption(s, a, a.optionBtn, now);
        }
        return;
      }
    }

    if (a.phase === "delay") {
      // Counted from the FIRST option click on the high-resolution clock, and
      // woken by a timer so it lands on time rather than on the next frame.
      const tn = tnow();
      const dueIn = Math.max(a.userDelayMs - (tn - a.tFirstDone), a.floorMs - (tn - a.tLastDone));
      if (dueIn > 0) {
        if (!a.delayTimer) {
          a.delayTimer = setTimeout(() => {
            a.delayTimer = 0;
            if (session === s && s.attempt === a) superviseSession();
          }, dueIn);
        }
        return;
      }
      a.phase = "submit";
      a.submitStartedAt = now;
      a.submitTimeoutMs = Math.min(CONFIG.SUBMIT_TIMEOUT_MS, usableMs);
    }

    if (a.phase === "submit") {
      const btn = findSubmitButton(container);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        // Remember what the poll looks like at the instant of the click, so we
        // can tell whether the page then reacted to it.
        const preSig = outcomeSignature(container);
        const preText = (btn.textContent || "").trim();
        btn.click();
        const tClick = tnow();
        s.answered = true;
        beginSubmitCheck(s, a, btn, preSig, preText, tClick, now);
        dropAttempt(s);
        resetSelectionAfterPoll();
        return;
      }
      if (now - a.submitStartedAt >= a.submitTimeoutMs) {
        failAttempt(
          s,
          `Selected "${a.letter}", but couldn't find/click Submit button.`,
          "Gave up looking for a clickable Submit button after the timeout."
        );
      }
    }
  }

  // ================= What the PAGE says back =================
  // PW.live answers a click it doesn't like with an error such as
  // "Unauthorised Scope Access". That message is the site's own — but only we
  // know WHICH of our steps it followed, so we watch for it, say so in the
  // status line, and (for a refused option click) retry sooner. This is what
  // lets you tell whether the click timing in the popup is too aggressive.
  const PAGE_ERROR_RE = /unauthori[sz]ed|scope access/i;

  function watchPageErrors(s) {
    if (s.errorObserver || !document.body) return;
    try {
      const looksLikeError = (t) => !!t && t.length <= 200 && PAGE_ERROR_RE.test(t);
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "characterData") {
            const t = (r.target.data || "").trim();
            if (looksLikeError(t)) return onPageError(s, t);
          }
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1 && n.nodeType !== 3) continue;
            const t = (n.textContent || "").trim();
            if (looksLikeError(t)) return onPageError(s, t);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      s.errorObserver = mo;
    } catch (err) {
      logError("watchPageErrors failed", err);
    }
  }

  function stopPageErrorWatch(s) {
    if (s && s.errorObserver) {
      s.errorObserver.disconnect();
      s.errorObserver = null;
    }
  }

  function onPageError(s, text) {
    if (session !== s || s.state === "ended") return;
    const t = tnow();
    const last = s.pageErrors[s.pageErrors.length - 1];
    if (last && t - last.t < 400) return; // the same toast re-rendering
    s.pageErrors.push({ t, text });
    log(`The PAGE showed "${text}" — that is PW.live's own message, not Poll Assist's.`);
    const c = s.submitCheck;
    const a = s.attempt;
    if (c && !c.done) {
      // It followed our Submit click: say so now instead of waiting out the 3 s.
      c.pageError = { t, text };
      finishSubmitCheck(s, null, false, "rejected");
      return;
    }
    if (a && a.phase === "confirm" && a.clickedAt) {
      // It followed our option click, which the page therefore refused. Retry soon.
      a.pageErrorAt = Date.now();
      superviseSession();
    }
  }

  // ================= Did Submit actually take? =================
  // Clicking Submit isn't the same as the page accepting it: a click can be
  // ignored (a stale handler, a re-render in the middle of it...). So after
  // the click we look for ANY sign the page reacted, and say honestly what we
  // saw: confirmed (and how long it took) or "didn't confirm". There is
  // deliberately no automatic retry — a second Submit could double-submit.

  // Which moment the timing readout counts from, and how to say it. If you
  // pick your answer after the poll is already running, the clock starts at
  // your pick, so your own thinking time never looks like extension delay.
  function timingBase(s, a) {
    const pickedLater = !!a.armedPerf && (a.armedPerf > s.t0 || s.viaArm);
    return pickedLater
      ? { base: a.armedPerf, since: "after you picked it" }
      : { base: s.t0, since: "after the poll appeared" };
  }

  // Like uiSignature, but digits are normalised so a ticking countdown or a
  // live vote count can't be mistaken for "the page reacted".
  function outcomeSignature(container) {
    return container ? uiSignature(container, true) : null;
  }

  function submitEvidence(c, container) {
    const b = c.btn;
    if (!b.isConnected) return "the Submit button went away";
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return "the Submit button was disabled";
    if ((b.textContent || "").trim() !== c.btnText) return "the Submit button changed";
    if (c.wsSent) return "the page sent the answer over the poll socket";
    if (!container) return "the poll view closed";
    if (outcomeSignature(container) !== c.sig) return "the poll view changed";
    return null;
  }

  function timelineText(c, why, tDone, outcome) {
    const rel = (t) => (t ? `+${fmtMs(t - c.base)}` : "—");
    const lines = [
      `Click timing: ${c.mode}.  Measured from ${c.since === "after you picked it" ? "when you picked the answer" : "when the poll appeared"}:`,
      `  poll on screen, answer ready   ${rel(c.tBegin)}`,
      `  option clicked                 ${rel(c.tSelected)}`,
      `  page registered it             ${rel(c.tMarked)}`,
      `  Submit clicked                 ${rel(c.tClick)}   (your delay setting: ${Math.round(c.delayMs || 0)} ms)`,
    ];
    for (const e of c.errors || []) lines.push(`  PW.live showed "${e.text}"   ${rel(e.t)}   (not from Poll Assist)`);
    if (tDone) {
      if (why) lines.push(`  page confirmed                 ${rel(tDone)}   (${why})`);
      else if (outcome === "rejected") lines.push("  the page refused the Submit (see the message above)");
      else if (outcome === "ended") lines.push("  the poll ended before any confirmation was seen");
      else lines.push(`  no confirmation seen within ${fmtMs(CONFIG.SUBMIT_CONFIRM_MS)}`);
    }
    return lines.join("\n");
  }

  function beginSubmitCheck(s, a, btn, preSig, preText, tClick, now) {
    const tm = timingBase(s, a);
    const c = {
      letter: a.letter,
      clickedAt: now,
      tClick,
      btn,
      btnText: preText,
      sig: preSig,
      wsSent: false,
      done: false,
      observer: null,
      base: tm.base,
      since: tm.since,
      sinceMs: tClick - tm.base,
      tBegin: a.tBegin,
      tSelected: a.tSelected,
      tMarked: a.tMarked,
      delayMs: a.delayMs,
      mode: { fast: "Fast", careful: "Careful", exact: "Exact" }[pacingMode()],
      gapMs: a.delayMs,
      errors: s.pageErrors, // shared with the session: shows errors the page gave at ANY step of this poll
      pageError: null,
    };
    s.submitCheck = c;
    setStatus(`Submit clicked ${fmtMs(c.sinceMs)} ${c.since} — waiting for the page to confirm…`, "ready", timelineText(c, null, 0));
    // A page that reacts inside the click is already done; otherwise watch for its reaction.
    evaluateSubmitCheck(s, currentPollContainer(), now);
    if (!c.done) watchSubmitOutcome(s, c);
  }

  // Notice the page's reaction the moment it happens, not on the next frame.
  function watchSubmitOutcome(s, c) {
    try {
      const container = currentPollContainer();
      const mo = new MutationObserver(() => {
        if (c.done || session !== s || s.state === "ended") return;
        evaluateSubmitCheck(s, currentPollContainer(), Date.now());
      });
      const deep = { attributes: true, childList: true, characterData: true, subtree: true };
      if (container && container.parentElement) mo.observe(container.parentElement, { childList: true }); // the poll view itself being removed
      if (container) mo.observe(container, deep);
      if (c.btn.parentElement) mo.observe(c.btn.parentElement, deep);
      c.observer = mo;
    } catch (err) {
      logError("watchSubmitOutcome failed", err);
    }
  }

  function evaluateSubmitCheck(s, container, now, quiet) {
    const c = s.submitCheck;
    if (!c || c.done) return;
    const why = submitEvidence(c, container);
    // Once the deadline has passed the page closes/changes the poll view on its
    // own, so a change seen then says nothing about OUR submit.
    if (now > s.deadlineAt) {
      finishSubmitCheck(s, null, quiet, "ended");
      return;
    }
    if (why) {
      finishSubmitCheck(s, why, quiet);
      return;
    }
    if (now - c.clickedAt >= CONFIG.SUBMIT_CONFIRM_MS) finishSubmitCheck(s, null, quiet);
  }

  function finishSubmitCheck(s, why, quiet, outcome) {
    const c = s.submitCheck;
    if (!c || c.done) return;
    c.done = true;
    if (c.observer) {
      c.observer.disconnect();
      c.observer = null;
    }
    setTimeout(() => stopPageErrorWatch(s), 1500);
    const tDone = tnow();
    if (quiet) {
      log("Submit check closed without a verdict:", why || "no sign of acceptance seen");
      return;
    }
    const detail = timelineText(c, why, tDone, outcome);
    if (why) {
      setStatus(`Submitted "${c.letter}" ${fmtMs(c.sinceMs)} ${c.since} (the page confirmed ${fmtMs(tDone - c.tClick)} later).`, "success", detail);
    } else if (outcome === "rejected") {
      const pe = c.pageError;
      const mode = pacingMode();
      let hint;
      if (mode === "exact") {
        hint = "PW.live needs a few ms between the option click and Submit — raise Delay before submitting to at least 0.01 s, or pick Fast under Click timing.";
      } else if (mode === "fast") {
        // Wait longer before Submit on the next polls (this poll's Submit was already sent).
        learnedSubmitGapMs = Math.min(100, Math.max(learnedSubmitGapMs, (c.gapMs || CONFIG.MIN_SUBMIT_GAP_MS) * 3, 30));
        hint = `Poll Assist will wait ${Math.round(learnedSubmitGapMs)} ms before Submit from now on.`;
      } else {
        hint = "Try submitting by hand — if PW shows it then too, it's your PW session.";
      }
      setStatus(`Submit clicked ${fmtMs(c.sinceMs)} ${c.since}, but PW.live then showed "${pe.text}" (${fmtMs(pe.t - c.tClick)} later). ${hint}`, "warning", detail);
      warn(`PW.live refused the Submit: "${pe.text}".`);
    } else if (outcome === "ended") {
      setStatus(`Submit clicked ${fmtMs(c.sinceMs)} ${c.since}, but the poll ended before the page confirmed it.`, "warning", detail);
      warn("Submit was clicked, but the poll ended before any confirmation was seen.");
    } else {
      setStatus(`Submit clicked ${fmtMs(c.sinceMs)} ${c.since}, but the page didn't confirm it — check the poll.`, "warning", detail);
      warn(`Submit was clicked, but the page showed no sign of accepting it within ${CONFIG.SUBMIT_CONFIRM_MS} ms.`);
    }
  }

  // The page sending a poll frame after our Submit click is evidence the
  // answer left the page (we can only see poll-topic WebSocket frames).
  function noteOutgoingPollFrame(payload) {
    const s = session;
    const c = s && s.submitCheck;
    if (!c || c.done) return;
    const pid = payload && (payload.pollId || (payload.data && payload.data.pollId));
    if (pid && s.meta && s.meta.pollId && pid !== s.meta.pollId) return;
    c.wsSent = true;
    evaluateSubmitCheck(s, currentPollContainer(), Date.now());
  }

  // The user just armed an answer. If a poll is running right now, act on it
  // immediately (opening the panel if it isn't showing) instead of waiting
  // for the next one.
  function onAnswerArmed() {
    if (!selectedOption) return;
    armedAt = Date.now();
    armedPerf = tnow();
    const s = session;
    if (s && s.state === "live") {
      // Already answered, or its window has passed: the pick is for the next poll.
      if (s.answered || armedAt > s.deadlineAt) return;
      s.userToggled = false; // arming is the user's latest, explicit instruction
      if (s.clicks >= CONFIG.MAX_OPEN_CLICKS) {
        s.clicks = 0;
        s.lastClickAt = 0;
      }
      log("Answer armed while a poll is running — acting on it now.");
      superviseSession();
      return;
    }
    detectDomOnlyPoll(true);
  }

  // ================= Fallback detection (no WebSocket info) =================
  // A live poll UI is on screen and an answer is armed, but no WebSocket
  // event told us about it (missed frame, socket reconnecting, ...).
  function detectDomOnlyPoll(viaArm) {
    if (!selectedOption) return;
    if (session && session.state === "live") return;
    // Right after a poll ends the site often shows a results view built from the
    // same markup; give it a moment rather than mistake that for a new poll.
    if (Date.now() - lastEndedAt < CONFIG.POST_POLL_QUIET_MS) return;
    const container = currentPollContainer();
    if (!container) return;
    if (lastUiMark && lastUiMark.node === container && lastUiMark.sig === uiSignature(container)) return; // same UI we already dealt with
    if (!looksLikeLiveVote(container)) return;
    beginSession({ id: `dom-${++sessionSeq}`, meta: null, source: "dom", viaArm });
  }

  // ================= Detecting a pending poll via the icon color =================
  // The poll icon's SVG path fill changes from white (#ffffff, idle) to the
  // site's theme color when a poll becomes pending. Important: this color
  // appears to be a persistent "a poll has happened" marker rather than one
  // that resets between polls, so we only act on it actually *changing* to
  // a pending value (an edge), never on it simply remaining pending. This
  // is a fallback signal only — it never clicks anything itself; it just
  // starts a session, and the session decides whether opening is needed.
  function getPollIconFill() {
    try {
      const pollIcon = document.querySelector("#poll-icon");
      const path = pollIcon ? pollIcon.querySelector("svg path") : null;
      if (!path) return null;
      return (path.getAttribute("fill") || "").trim().toLowerCase();
    } catch (err) {
      logError("getPollIconFill failed", err);
      return null;
    }
  }

  function isPendingFillValue(fill) {
    return !!fill && fill !== "#ffffff" && fill !== "white";
  }

  let lastKnownPollIconFill = null; // null = not yet observed
  function checkPollIconFill() {
    const fill = getPollIconFill();
    if (fill === null) return;
    if (lastKnownPollIconFill === null) {
      lastKnownPollIconFill = fill; // first look just establishes the baseline
      return;
    }
    if (fill === lastKnownPollIconFill) return;
    const wasPending = isPendingFillValue(lastKnownPollIconFill);
    lastKnownPollIconFill = fill;
    if (!isPendingFillValue(fill) || wasPending) return; // only a fresh idle -> pending edge counts
    beginSession({ id: `icon-${++sessionSeq}`, meta: null, source: "icon" });
  }

  // A dedicated, narrowly-scoped observer on just the poll icon's own SVG
  // path — cheap to run, and reacts the instant the fill color flips to
  // "pending" without needing to watch attribute changes across the whole
  // page. Re-attaches automatically if the site re-renders the icon as a
  // new DOM node (common in SPA frameworks).
  let pollIconObserver = null;
  let watchedPollIconPath = null;
  function ensurePollIconWatched() {
    try {
      const pollIcon = document.querySelector("#poll-icon");
      const path = pollIcon ? pollIcon.querySelector("svg path") : null;
      if (!path || path === watchedPollIconPath) return;
      if (pollIconObserver) pollIconObserver.disconnect();
      pollIconObserver = new MutationObserver(() => {
        checkPollIconFill();
      });
      pollIconObserver.observe(path, { attributes: true, attributeFilter: ["fill"] });
      watchedPollIconPath = path;
      log("Now watching poll icon for pending-color changes.");
    } catch (err) {
      logError("ensurePollIconWatched failed", err);
    }
  }

  // If the user clicks the poll icon themselves, they're driving the panel —
  // from then on this poll, we never click it for them (unless they arm an
  // answer, which is an explicit request; see onAnswerArmed).
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !session || session.state === "ended") return;
      const t = e.target;
      if (t && t.closest && t.closest("#poll-icon")) session.userToggled = true;
    },
    true
  );

  // Could this batch of DOM changes involve the poll UI? Chat messages and
  // other page noise never add buttons/inputs, so they don't warrant an
  // immediate re-check (the per-frame loop still covers everything else).
  function mutationsRelevant(records) {
    try {
      const container = scanCache.node;
      for (const r of records) {
        if (r.type === "attributes") return true; // only "disabled" is observed
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.matches("button, input") || n.querySelector("button, input"))) return true;
        }
        for (const n of r.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (container && (n === container || n.contains(container))) return true;
          if (n.matches("button, input") || n.querySelector("button, input")) return true;
        }
      }
    } catch (_e) {
      return true; // when in doubt, check
    }
    return false;
  }

  // ================= Main observer loop =================
  // Poll Assist only operates on live classes (identified by the
  // presence of #poll-icon). Recorded classes have no reliable anchor
  // for correct on-screen positioning — after trying several fallback
  // selectors that didn't hold up across different page layouts, this is
  // now simply out of scope rather than a half-working feature.
  //
  // Once we've confirmed we're in a live class (seen the icon at least
  // once), that determination sticks for the rest of the page's life —
  // a momentary absence (the site's own framework re-rendering the
  // toolbar mid-frame, which briefly removes and re-adds elements, is
  // common) must never tear the button down and rebuild it. Only an
  // icon that's *never once* appeared within the initial grace window
  // is treated as "this is a recorded class."
  let everSawPollIcon = false;

  function tick() {
    if (destroyed) return;

    const pollIconExists = !!document.querySelector("#poll-icon");
    if (pollIconExists) everSawPollIcon = true;

    if (!everSawPollIcon) {
      const gracePassed = Date.now() - scriptStartTime > CONFIG.TOOLBAR_WAIT_MS;
      if (!gracePassed) return; // still within the initial grace window — keep waiting

      // Never saw the icon at all within the grace window — recorded
      // class. Tear down anything that might exist and stay inactive.
      if (answerWrapRef && document.body.contains(answerWrapRef)) {
        answerWrapRef.remove();
        log("No live poll icon found on this page — Poll Assist is inactive here.");
      }
      answerWrapRef = null;
      iconRef = null;
      const dropdownEl = document.getElementById("pw-answer-dropdown");
      if (dropdownEl) dropdownEl.remove();
      dropdownRef = null;
      return;
    }

    ensureButtonExists();
    ensurePollIconWatched();
    checkPollIconFill();
    detectDomOnlyPoll();
  }

  // Coalesces potentially-many MutationObserver callbacks (a busy SPA can
  // batch-fire several in a single frame) into at most one tick() per
  // animation frame, avoiding redundant full-page scans without adding
  // any perceptible detection latency.
  let tickScheduled = false;
  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    nextFrame(() => {
      tickScheduled = false;
      tick();
    });
  }

  function start() {
    loadSettings();

    try {
      observer = new MutationObserver((records) => {
        domDirty = true;
        // While a poll is being worked on, react at once (this callback runs
        // right after the DOM change) instead of waiting for the next frame.
        if (session && session.state === "live" && mutationsRelevant(records)) {
          try {
            superviseSession();
          } catch (err) {
            logError("superviseSession failed", err);
          }
        }
        scheduleTick();
      });
      // Broad attribute watching across the whole page would be
      // expensive (lots of unrelated elements churn class/style
      // attributes). Poll-container detection only needs childList
      // changes; the poll icon's own fill-color change is watched
      // separately by a narrowly-scoped observer (see
      // ensurePollIconWatched) for a cheap, instant reaction instead.
      // "disabled" is watched too so a Submit button that becomes enabled is
      // clicked the moment it does. (Watching class/style would be far too noisy.)
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    } catch (err) {
      logError("Failed to start MutationObserver", err);
    }

    // 500ms rather than 1000ms so the pending-poll color change (and any
    // SPA re-renders the MutationObserver misses) gets picked up promptly.
    injectPollId = setInterval(tick, 500);
    // Coming back to a tab that sat in the background: catch up immediately.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        domDirty = true;
        scheduleTick();
      }
    });
    tick();

    trackingRafId = requestAnimationFrame(trackPosition);
    log("Started.");
  }

  function destroy() {
    destroyed = true;
    try {
      if (observer) observer.disconnect();
    } catch (err) {
      logError("Error disconnecting observer", err);
    }
    try {
      if (pollIconObserver) pollIconObserver.disconnect();
    } catch (err) {
      logError("Error disconnecting poll-icon observer", err);
    }
    if (injectPollId) clearInterval(injectPollId);
    if (trackingRafId) cancelAnimationFrame(trackingRafId);
    log("Cleaned up.");
  }

  // ================= WebSocket-driven poll detection =================
  // PW.live's live-class socket (central-socket.penpencil.co) sends a
  // real, unambiguous event the instant a poll starts:
  //   "poll {"operation":"start","pollId":"...","data":{...}}"
  // and a corresponding "stop_expiry" event as it's about to close. This
  // is far more reliable than watching for DOM/color changes — it fires
  // fresh for every single poll, not just the first. It starts a poll
  // session; the DOM-based color-change detection above stays in place as
  // a fallback for when a frame is ever missed.
  function parseWSFrame(raw) {
    if (typeof raw !== "string") return null;
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      try {
        return { topic: null, payload: JSON.parse(raw) };
      } catch (_e) {
        return null;
      }
    }
    const topic = raw.slice(0, spaceIdx);
    const jsonPart = raw.slice(spaceIdx + 1);
    try {
      return { topic, payload: JSON.parse(jsonPart) };
    } catch (_e) {
      return null;
    }
  }

  function handlePollSocketPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const op = payload.operation;
    const pollId = payload.pollId || (payload.data && payload.data.pollId);

    if (op === "start") {
      if (pollId && handledPollStartIds.has(pollId)) return; // duplicate delivery of the same event
      if (pollId) {
        handledPollStartIds.add(pollId);
        // Simple unbounded-growth guard for very long sessions.
        if (handledPollStartIds.size > 200) {
          const oldest = handledPollStartIds.values().next().value;
          handledPollStartIds.delete(oldest);
        }
      }

      const data = (payload && payload.data) || {};
      const realOptions = Array.isArray(data.pollOptions)
        ? data.pollOptions
            .map((o) => (o && typeof o.optionLabel === "string" ? o.optionLabel.trim().toUpperCase() : null))
            .filter(Boolean)
        : null;
      const durationMs = typeof data.expiryDuration === "number" && data.expiryDuration > 0 ? data.expiryDuration * 1000 : null;
      const meta = { pollId: pollId || null, options: realOptions, durationMs };
      log("Captured real poll metadata from WebSocket:", meta);

      beginSession({ id: pollId || `ws-${++sessionSeq}`, meta, source: "ws" });
    } else if (op === "stop_expiry" || op === "stop" || op === "end") {
      log("WebSocket: poll", pollId || "(unknown id)", "is stopping/ending — operation:", op);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__pwPollAssistWS !== true) return;

    if (settings.debug) {
      console.log(
        `%c[PW Poll Assist][WS ${msg.direction}]`,
        "color:#34d399;font-weight:bold;",
        msg.url,
        msg.data
      );
    }

    const parsed = parseWSFrame(msg.data);
    if (parsed && parsed.topic === "poll") {
      if (msg.direction === "send") noteOutgoingPollFrame(parsed.payload);
      else handlePollSocketPayload(parsed.payload);
    }
  });

  // Only tear down on a real unload. `beforeunload` is NOT one: it also fires
  // when the user cancels a "leave this page?" prompt (or starts a download /
  // mailto: navigation), after which the page carries on — and the extension,
  // having destroyed itself, silently stopped working until a reload.
  window.addEventListener("pagehide", (e) => {
    if (!e.persisted) destroy();
  });

  start();
})();
