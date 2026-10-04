// Defense in depth only: catches obvious emails, links and phone numbers, not every way to share contact details.
export const contactDetailsPattern = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:https?:\/\/|www\.)\S+|\b\+\d[\d\s().-]{6,}\d\b|\b\d{10,15}\b)/i;

export function containsContactDetails(...values) {
  return values.some((value) => typeof value === 'string' && contactDetailsPattern.test(value));
}
