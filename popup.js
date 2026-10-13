(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    autoSubmitEnabled: true,
    submitDelayMs: 150,
    debug: false,
    hideWithPlayerControls: true,
    autoOpenPollPanel: true,
    pacing: "fast",
    fastMode: false, // legacy switch from 3.6.0 (means "instant"); cleared whenever Click timing is changed
  };

  const autoSubmitEl = document.getElementById("autoSubmitEnabled");
  const submitDelayEl = document.getElementById("submitDelay"); // in seconds, 0-5
  const submitDelayNumberEl = document.getElementById("submitDelayNumber"); // in seconds, 0-60
  const hideWithPlayerControlsEl = document.getElementById("hideWithPlayerControls");
  const autoOpenPollPanelEl = document.getElementById("autoOpenPollPanel");
  const pacingEl = document.getElementById("pacing");
  const pacingDescEl = document.getElementById("pacingDesc");
  const PACING_TEXT = {
    fast: "As fast as PW.live accepts: acts the moment the poll appears and sends Submit 10 ms after the option click. Recommended.",
    careful: "Also waits for the page to paint before clicking, and a frame before Submit, like the original. Slowest.",
    exact: "No waits of its own: Submit goes exactly when your delay says. PW.live refuses a Submit under ~10 ms, so keep the delay at 0.01 s or more.",
  };
  // Old names (and the 3.6.0 on/off Fast mode switch) still map onto the three choices.
  function normalizePacing(settings) {
    const alias = { safe: "careful", frame: "fast", instant: "exact" };
    let p = alias[settings.pacing] || settings.pacing;
    if (p !== "fast" && p !== "careful" && p !== "exact") p = "fast";
    if (p === "fast" && settings.fastMode) p = "exact";
    return p;
  }
  function renderPacing(settings) {
    const val = normalizePacing(settings);
    for (const b of pacingEl.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.val === val));
    pacingDescEl.textContent = PACING_TEXT[val];
  }
  const debugEl = document.getElementById("debug");
  const resetBtn = document.getElementById("resetBtn");
  const statusEl = document.getElementById("statusMsg");
  const versionBadgeEl = document.getElementById("versionBadge");

  // Read the popup's version display from the manifest rather than
  // hardcoding a string that has to be kept in sync by hand.
  try {
    if (versionBadgeEl) versionBadgeEl.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (err) {
    console.error("Couldn't read extension version", err);
  }

  // Settings are stored internally as milliseconds (submitDelayMs) so the
  // content script's timing logic doesn't need to care about display
  // units. The popup UI works in seconds for readability, converting at
  // the boundary.
  function clampDelayMs(ms) {
    const n = Number(ms);
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.submitDelayMs;
    return Math.min(60000, Math.max(0, Math.round(n)));
  }

  function msToSeconds(ms) {
    return Math.round(ms) / 1000;
  }

  function secondsToMs(seconds) {
    const n = Number(seconds);
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.submitDelayMs;
    return clampDelayMs(n * 1000);
  }

  // The slider's filled-in-accent-color portion is drawn via a --pct
  // custom property consumed by a CSS linear-gradient (see popup.css) —
  // range inputs have no native concept of "filled up to here", so this
  // has to be kept in sync in JS whenever the value changes.
  function updateSliderFill() {
    const min = Number(submitDelayEl.min) || 0;
    const max = Number(submitDelayEl.max) || 1;
    const val = Number(submitDelayEl.value);
    const pct = ((val - min) / (max - min)) * 100;
    submitDelayEl.style.setProperty("--pct", `${pct}%`);
  }

  function applyToForm(settings) {
    autoSubmitEl.checked = settings.autoSubmitEnabled;
    const delayMs = clampDelayMs(settings.submitDelayMs);
    const delaySeconds = msToSeconds(delayMs);
    // Slider only goes to 5s; clamp its displayed value but let the
    // number input show the true value even if it's higher.
    submitDelayEl.value = Math.min(delaySeconds, 5);
    submitDelayNumberEl.value = delaySeconds;
    updateSliderFill();
    hideWithPlayerControlsEl.checked = settings.hideWithPlayerControls;
    autoOpenPollPanelEl.checked = settings.autoOpenPollPanel;
    renderPacing(settings);
    debugEl.checked = settings.debug;
  }

  function showSaved() {
    statusEl.textContent = "Saved";
    statusEl.classList.remove("error");
    statusEl.classList.add("visible");
    clearTimeout(showSaved._t);
    showSaved._t = setTimeout(() => {
      statusEl.classList.remove("visible");
    }, 1200);
  }

  function saveField(patch) {
    try {
      chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
        const merged = Object.assign({}, DEFAULT_SETTINGS, result.settings, patch);
        chrome.storage.local.set({ settings: merged }, () => {
          if (chrome.runtime.lastError) {
            statusEl.textContent = "Couldn't save settings.";
            statusEl.classList.add("visible", "error");
            console.error(chrome.runtime.lastError);
            return;
          }
          showSaved();
        });
      });
    } catch (err) {
      statusEl.textContent = "Couldn't save settings.";
      statusEl.classList.add("visible", "error");
      console.error(err);
    }
  }

  // Load current settings on open.
  try {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
      applyToForm(Object.assign({}, DEFAULT_SETTINGS, result.settings));
    });
  } catch (err) {
    applyToForm(DEFAULT_SETTINGS);
    console.error(err);
  }

  autoSubmitEl.addEventListener("change", () => {
    saveField({ autoSubmitEnabled: autoSubmitEl.checked });
  });

  // Slider drives the number input live as you drag (both in seconds)...
  submitDelayEl.addEventListener("input", () => {
    submitDelayNumberEl.value = submitDelayEl.value;
    updateSliderFill();
  });
  submitDelayEl.addEventListener("change", () => {
    saveField({ submitDelayMs: secondsToMs(submitDelayEl.value) });
  });

  // ...and the number input lets you type an exact value, including
  // fractional seconds like 1.2, and beyond the slider's 5s max if
  // someone really wants a longer delay.
  submitDelayNumberEl.addEventListener("input", () => {
    const seconds = Number(submitDelayNumberEl.value);
    if (!Number.isNaN(seconds) && seconds <= 5) {
      submitDelayEl.value = seconds;
      updateSliderFill();
    }
  });
  submitDelayNumberEl.addEventListener("change", () => {
    const ms = secondsToMs(submitDelayNumberEl.value);
    const seconds = msToSeconds(ms);
    submitDelayNumberEl.value = seconds;
    if (seconds <= 5) submitDelayEl.value = seconds;
    updateSliderFill();
    saveField({ submitDelayMs: ms });
  });

  hideWithPlayerControlsEl.addEventListener("change", () => {
    saveField({ hideWithPlayerControls: hideWithPlayerControlsEl.checked });
  });

  autoOpenPollPanelEl.addEventListener("change", () => {
    saveField({ autoOpenPollPanel: autoOpenPollPanelEl.checked });
  });

  pacingEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-val]");
    if (!b) return;
    // Writing `fastMode: false` clears the old 3.6.0 switch so it can't override this choice.
    saveField({ pacing: b.dataset.val, fastMode: false });
    renderPacing({ pacing: b.dataset.val, fastMode: false });
  });

  debugEl.addEventListener("change", () => {
    saveField({ debug: debugEl.checked });
  });

  resetBtn.addEventListener("click", () => {
    applyToForm(DEFAULT_SETTINGS);
    try {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => showSaved());
    } catch (err) {
      console.error(err);
    }
  });
})();
