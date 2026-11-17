// The submission value of each form-associated custom element
// (ElementInternals.setFormValue()): a JavaScript value (a string, a File
// or a list of FormData entries) that the entry list of its form reads
// (src/dom/form-data.js).
const submissions = new WeakMap();

export function setSubmissionValue(element, value) {
  submissions.set(element, value);
}

export function submissionValue(element) {
  return submissions.get(element) ?? null;
}
