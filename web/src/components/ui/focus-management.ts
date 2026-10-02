import type * as React from "react";

const FORM_CONTROL_SELECTOR = [
  "[data-autofocus]",
  'input:not([type="hidden"]):not([type="file"]):not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
].join(",");

function isHiddenControl(element: HTMLElement) {
  return Boolean(
    element.hidden ||
      element.getAttribute("aria-hidden") === "true" ||
      element.closest("[hidden], [inert]") ||
      element.classList.contains("hidden") ||
      element.classList.contains("sr-only") ||
      element.style.display === "none" ||
      element.style.visibility === "hidden",
  );
}

function getInitialFormControl(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FORM_CONTROL_SELECTOR)).find(
    (element) => !isHiddenControl(element),
  );
}

function getEventSurface(event: React.SyntheticEvent | Event) {
  if (event.currentTarget instanceof HTMLElement) return event.currentTarget;
  return event.target instanceof HTMLElement ? event.target : null;
}

export function focusSheetSurface(event: React.SyntheticEvent | Event) {
  event.preventDefault();
  const surface = getEventSurface(event);
  surface?.focus();
}

export function focusDialogInitialTarget(event: React.SyntheticEvent | Event) {
  event.preventDefault();
  const surface = getEventSurface(event);
  if (!surface) return;
  const target = getInitialFormControl(surface);
  if (target) {
    target.focus();
  } else {
    surface.focus();
  }
}
