// Progressive enhancement only: every page works without this file.
// No network calls, no storage, no timers.

// Chrome's back-forward cache can restore the form with the text typed before submitting.
// Only act on such restores, so a normal validation-error re-render keeps the user's text.
// form.reset() isn't enough: it reverts to defaultValue, which on a restored validation-error
// page is the server-preserved text. Clearing both guarantees an empty textarea.
// A stale validation error would be confusing above an empty form, so drop it too.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  document.querySelector('#feedback-form .error')?.remove();
  const textarea = document.querySelector('#feedback-form textarea');
  if (!textarea) return;
  textarea.defaultValue = '';
  textarea.value = '';
});

// Replace the thanks page in history so Back from the new form doesn't return to it.
document.getElementById('submit-another')?.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  location.replace('/');
});
