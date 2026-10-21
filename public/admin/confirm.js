// Asks before submitting any form carrying data-confirm.
document.addEventListener("submit", (event) => {
  const message = event.target instanceof HTMLFormElement ? event.target.dataset.confirm : undefined;
  if (message && !confirm(message)) event.preventDefault();
});
