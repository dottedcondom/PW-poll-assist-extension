# Firefox Add-on (AMO) submission notes

Reference copy for the "Version notes" and "Notes to Reviewer" fields when
submitting to addons.mozilla.org. Paste the relevant block into the form.

## Version notes (v3.7.0)

Bug-fix release for poll detection and submission. The poll panel could fail to
open, or be closed again, when a poll started (the site's poll icon is a toggle
and two code paths could each click it). Poll handling is now a single state
machine that clicks the icon only when the poll isn't already showing. An
answer picked while a poll is already running is now applied immediately.
Also fixed: choosing the wrong "Submit" button on pages with several; polls
skipped because of client/server clock skew; a deselected or changed answer
still being submitted after the delay; a stale answer staying armed for the
next poll; the extension disabling itself after a cancelled "leave page?"
prompt; stalling while the tab is in the background; and high idle CPU use on
busy pages.

Interaction timing: the site refuses a Submit that follows the option click by
less than ~10 ms (it shows its own "Unauthorised Scope Access" message), so the
extension never sends one sooner (a "Click timing" setting offers Fast, the
default; Careful, which also waits a painted frame between steps; and Exact,
which adds no waits of its own). Submit is only clicked once the page has
visibly registered the selected option, a click the page ignores is retried (up
to 3 times), an already-selected option is never clicked and an option the page
rebuilt is never re-clicked, and an empty answer is never submitted. After
Submit is clicked the extension reports whether the page showed any sign of
accepting it, and if the page shows an authorisation error it reports which
step it followed. The status line also shows measured timing. Outgoing
poll-topic WebSocket frames (already forwarded by the hook in earlier versions)
are used, locally, as one signal that the answer was sent. No new permissions,
no network requests.

## Notes to Reviewer

This extension does not require a user account or login of any kind. It runs
entirely on pw.live class pages and needs no credentials to test — the poll
detection and auto-submit UI are visible as soon as a live class page loads.
