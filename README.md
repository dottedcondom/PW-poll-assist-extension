# Poll Assist for PW Live

A small Chrome extension for PW.live **live classes**. Pick the answer you've already worked out (A/B/C/D), and the moment a poll appears on screen, it's selected — and submitted, if you want — automatically.

[![License: MIT](https://img.shields.io/badge/license-MIT-4caf50.svg)](./LICENSE)

> **Unofficial project.** Not affiliated with, endorsed by, or connected to Physics Wallah or PW.live in any way. It may break whenever PW.live changes their site.

<p align="center">
  <img src="screenshots/poll-panel.png" alt="Poll Assist panel with option B armed and auto-submit on" width="420">
</p>

## Table of contents

- [Installation](#installation)
- [How to use](#how-to-use)
- [Settings](#settings)
- [Privacy](#privacy)
- [Responsible use](#responsible-use)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Installation

Not published on the Chrome Web Store — you load it directly from this repo.

1. **Download or clone this repository**
   ```bash
   git clone https://github.com/dottedcondom/pw-poll-extension.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Toggle on **Developer mode** (top right)
4. Click **Load unpacked** and select the folder you downloaded
5. Open a **live** class on `pw.live` — a small control appears next to the poll icon within a few seconds

## How to use

1. While solving the problem, click the checkmark icon to open the panel, then click **A**, **B**, **C**, or **D** to mark your intended answer — it turns green once armed. Click the same option again to deselect it.
2. Keep **Auto-submit** checked to have it click Submit automatically. This preference is remembered across page reloads.
3. When the poll opens, your choice is selected (and submitted, if auto-submit is on) immediately. If a poll is *already running* when you pick an answer, it's opened and answered right away instead of waiting for the next one.
4. The status line tells you what happened and how fast — e.g. `Submitted "B" 48 ms after the poll appeared (the page confirmed 12 ms later).` Hover over it for a step-by-step breakdown. Clicking Submit is not counted as success: it waits for any sign the page took it, and if there is none within 3 seconds it says `Submit clicked …, but the page didn't confirm it — check the poll.` (It never retries Submit, because a second Submit could double-submit.) If you pick an answer after the poll is already running, the time is counted from your pick.

**Note:** this only works on **live** classes, not recorded ones.

## Settings

Click the extension's icon in Chrome's toolbar to open the settings panel:

| Setting | What it does |
|---|---|
| **Auto-submit** | Clicks Submit automatically once your pre-chosen answer is selected. Synced with the in-page toggle. |
| **Delay before submitting** | A slider (0–5s) plus a precise field for exact control over when it clicks Submit, counted from the moment the option is clicked. **0 means no delay of your own.** In Fast mode Submit still goes 10 ms after the option click, because PW.live refuses a Submit that comes sooner (see Click timing). Any other value is honored exactly. |
| **Click timing** | **Fast** (default): acts the moment the poll appears and sends Submit 10 ms after the option click — the least PW.live accepts. **Careful**: also waits a painted frame before the first click and before Submit, like the original; the slowest. **Exact**: no waits of its own — Submit goes exactly when your delay says, so keep the delay at 0.01 s or more or PW.live will refuse it. If PW.live ever refuses a Submit even in Fast, Poll Assist waits longer before Submit on the following polls and says so in the status line. |
| **Hide with video controls** | Fades the button out after a few seconds of no mouse movement, and back in when you move it — like the video player's own controls. |
| **Auto-open poll panel** | Opens the poll panel automatically as soon as a poll becomes available. It only ever clicks the poll icon when the poll isn't already showing, and never fights you if you open or close the panel yourself. If you turn this off, arming an answer won't open the panel either — it answers as soon as you open it. |
| **Debug logging** | Verbose console output (F12), for troubleshooting. |

Changes apply immediately — no page reload needed.

## Privacy

- **No network calls.** The extension never sends anything to any server — no analytics, no telemetry.
- **Settings stay on your device.** Never synced to any account or cloud.
- **Minimal permissions.** The extension only asks for local storage access — nothing else.
- **No chat or other page data is read or stored** — the extension only pays attention to the specific poll events it needs to do its job.
- **Debug logging is off by default**, and even when turned on, only prints to your own browser console.

## Responsible use

This is meant for one specific case: you've already worked out the answer yourself, and you just want it submitted reliably and without delay once the poll opens — not to skip the problem entirely. Polls exist to check that you're actually following along; using this to answer things you haven't worked through defeats that purpose and isn't what this tool is for.

## Troubleshooting

- **Button not appearing** — this only works on live classes (identified by the presence of the poll icon). Recorded classes aren't supported.
- **Button not appearing/reappearing** — open the popup and turn **off** "Hide with video controls" to keep it always visible.
- **No errors, but nothing happens** — open DevTools Console (F12); warnings prefixed `[PW Poll Assist]` usually mean PW.live's markup for that poll looks different from what the extension expects.
- **PW.live shows an error such as "Unauthorised Scope Access"** — that message comes from PW.live itself, not from Poll Assist (which makes no network calls at all). PW.live shows it when a Submit arrives too soon after the option click. The status line now tells you which step it followed and how many ms later (hover it for the timeline). Leave **Click timing** on **Fast** (the default); if you chose **Exact**, keep **Delay before submitting** at 0.01 s or more. If the page never marks the option, Poll Assist tries up to 3 times, then stops **without submitting** and says so. If you still get the error, check whether it also appears when you mark and submit by hand — if it does, it's your PW.live session (refresh or log in again), not the extension.
- **Want more detail** — turn on "Debug logging" in the popup for a step-by-step console trace.
- **Still stuck** — open an issue with a screenshot or console output, and it'll get looked at.

## Contributing

Issues and pull requests are welcome, especially if PW.live changes something and the extension stops working. A good bug report includes a screenshot or console output — see [Troubleshooting](#troubleshooting).

## Changelog

<details>
<summary>Click to expand version history</summary>

**v3.7.0** — Faster, and no more "Unauthorised Scope Access". Testing on the real PW.live showed what it actually needs: a Submit must come at least ~10 ms after the option click (0 ms is refused, 10 ms works), while the first click can go the instant the poll appears. So the default **Fast** click timing now acts immediately and sends Submit 10 ms after the option click — about a third of the time of the previous default. The new **Click timing** setting replaces Fast mode: **Fast** (default), **Careful** (the old frame-by-frame pacing) and **Exact** (no waits of its own; your delay decides). If PW.live still refuses a Submit, the status line says which step it followed, and Fast waits longer before Submit on the following polls. Your **Delay before submitting** is now honored to the millisecond (it used to be rounded up to the next frame), and an explicit refusal of an option click is retried after ~60 ms instead of 300 ms.

**v3.6.0** — The status line now reports real timing (e.g. "Submitted B 48 ms after the poll appeared") with a step-by-step breakdown on hover, and checks whether the page actually accepted the Submit instead of assuming it did ("Submit clicked, but the page didn't confirm it — check the poll."). Added a one-frame pause between steps (and an optional **Fast mode** to skip it) to cope with PW.live answering with "Unauthorised Scope Access" — the real cause, a Submit sent too soon after the option click, was pinned down in v3.7.0. It also no longer clicks an option again when the page rebuilds the option list (a second click can unselect it), never clicks an option that is already selected, retries a click the page ignored (up to 3 tries) and never submits an empty answer.

**v3.5.2** — Fixed the poll panel sometimes not opening, or closing itself, when a poll started — especially when it was already open, or when one poll followed another. Picking an answer while a poll is already running now opens and answers it straight away. Also fixed: clicking the wrong "Submit" button on pages that have more than one; polls being skipped as "already expired" when your computer's clock was off; a deselected or changed answer still being submitted after the delay (and the status saying `Submitted "null"`); an answer staying armed for the next poll when auto-submit is off; Poll Assist stopping for good after cancelling a "Leave site?" prompt; and polls not being answered while the class tab was in the background. Much lower CPU use on busy pages. No delays are added anywhere: the only wait is the one you set, and with it at 0 Submit follows the moment the page has marked your option. Submit is never clicked before the page has registered the option, and if a page clears your selection right after it is made, it is selected again.

**v3.3** — Redesigned the delay slider with a smoother, more precise look and feel.

**v3.2** — Visual polish pass on the popup and in-page panel: smoother animations, better contrast, more consistent styling throughout.

**v3.1** — Reworked the popup's look and removed a status banner that didn't add much.

**v3.0** — Internal cleanup; version number is now read automatically instead of needing to be updated by hand in multiple places.

**v2.9** — Fixed a bug where a new poll could occasionally be missed right after the previous one closed, and a related bug where an already-answered poll could be mistaken for a new one.

**v2.8** — Fixed a flicker where the button would briefly disappear and reappear during normal page updates, and a bug where a failed submission could leave a stale answer armed for the next poll.

**v2.7** — Removed support for recorded classes rather than leaving it half-working — there's no reliable way to place the button reliably there.

**v2.5–v2.6** — Faster, more responsive detection; safeguards against duplicate actions.

**v2.1–v2.4** — Switched to detecting polls via the site's own real-time signal instead of guessing, for more reliable and immediate detection.

**v2.0** — Visual redesign: proper icon, polished popup and in-page panel, color-coded status.

**v1.1** — Added the settings popup (auto-submit, delay, debug logging).

**v1.0** — Initial release: pre-select an answer, auto-detect the poll, auto-submit.

</details>

## License

MIT — see [LICENSE](./LICENSE).
