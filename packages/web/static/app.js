// Two small behaviors, nothing else (the CSP allows only this file):
// forms with data-confirm ask first; permission rows save as soon as a choice is clicked.
document.addEventListener("submit", (event) => {
  const form = event.target;
  const question = form instanceof HTMLFormElement ? form.dataset.confirm : undefined;
  if (question && !window.confirm(question)) event.preventDefault();
});
document.addEventListener("change", (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.type === "radio") {
    const form = input.closest("form[data-autosubmit]");
    if (form) form.requestSubmit();
  }
});
