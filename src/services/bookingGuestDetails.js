import { z } from 'zod';
import { isCountryCode } from '../config/index.js';
import { travellerTypes } from '../config/referenceData.js';
import { containsContactDetails } from '../utils/contactDetails.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';

const travellerTypeByValue = new Map(travellerTypes.map((type) => [type.value, type]));
const dayMs = 24 * 60 * 60 * 1000;
const optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);
const optionalTime = z.preprocess((value) => value === '' ? null : value, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 14:30.').nullish()).transform((value) => value ?? null);

const guestSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter the full name of every guest.').max(120),
  traveller_type: z.enum(travellerTypes.map((type) => type.value), { error: 'Choose a traveller type for every guest.' }),
  age: z.number().int().min(0).max(120).nullish().transform((value) => value ?? null),
  nationality: z.string().trim().toUpperCase().refine(isCountryCode, 'Use an ISO country code for nationality.').nullish().transform((value) => value ?? null),
  room_number: z.number().int().min(1).max(50).nullish().transform((value) => value ?? null),
});

const guestDetailsSchema = z.object({
  guests: z.array(guestSchema).min(1, 'Add at least one guest.'),
  lead_guest_index: z.number().int().min(0),
  arrival_date: z.iso.date({ error: 'Enter the arrival date.' }),
  arrival_time: optionalTime,
  arrival_details: optionalText(200),
  departure_date: z.iso.date({ error: 'Enter the departure date.' }),
  departure_time: optionalTime,
  departure_details: optionalText(200),
  special_requests: optionalText(1000),
}).superRefine((input, context) => {
  const issue = (message, path) => context.addIssue({ code: 'custom', message, path });
  const lead = input.guests[input.lead_guest_index];
  if (!lead || lead.traveller_type !== 'adult') issue('Choose an adult as the lead guest.', ['lead_guest_index']);
  input.guests.forEach((guest, index) => {
    const type = travellerTypeByValue.get(guest.traveller_type);
    if (type.minAge == null) return;
    if (guest.age == null || guest.age < type.minAge || guest.age > type.maxAge) {
      issue(`Enter an age from ${type.minAge} to ${type.maxAge} for each ${type.label.toLowerCase()}.`, ['guests', index, 'age']);
    }
  });
  if (input.departure_date <= input.arrival_date) issue('Departure must be after arrival.', ['departure_date']);
  const text = [input.arrival_details, input.departure_details, input.special_requests, ...input.guests.map((guest) => guest.full_name)];
  if (containsContactDetails(...text)) issue('Guest details must not contain phone numbers, email addresses or links. The agency stays the contact point.', ['guests']);
});

function addDays(dateText, days) {
  return new Date(Date.parse(`${dateText}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}

/**
 * Validates guest details against the awarded request and offer, and returns the minimum stored record.
 * facts: { adults, children, infants, travelStartDate, travelEndDate, travelMonth, nights, roomCount, roomingRequired }
 */
export function parseGuestDetails(body, facts) {
  const parsed = guestDetailsSchema.safeParse(body ?? {});
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the guest details and try again.' };
  const input = parsed.data;
  const counts = { adult: 0, child: 0, infant: 0 };
  for (const guest of input.guests) counts[guest.traveller_type] += 1;
  if (counts.adult !== facts.adults || counts.child !== facts.children || counts.infant !== facts.infants) {
    return { error: `Enter exactly ${facts.adults} adult(s), ${facts.children} child(ren) and ${facts.infants} infant(s), as in the awarded request.` };
  }
  if (facts.travelStartDate) {
    if (input.arrival_date !== facts.travelStartDate || input.departure_date !== facts.travelEndDate) {
      return { error: `Arrival and departure must match the awarded travel dates (${facts.travelStartDate} to ${facts.travelEndDate}).` };
    }
  } else if (!input.arrival_date.startsWith(facts.travelMonth) || addDays(input.arrival_date, facts.nights) !== input.departure_date) {
    return { error: `Arrival must be in ${facts.travelMonth} and the stay must be ${facts.nights} night(s), as in the awarded request.` };
  }
  const roomNumbers = new Set(input.guests.map((guest) => guest.room_number).filter((room) => room != null));
  if ([...roomNumbers].some((room) => room > facts.roomCount)) return { error: `Room numbers must be between 1 and ${facts.roomCount}.` };
  if (facts.roomingRequired && input.guests.some((guest) => guest.room_number == null)) {
    return { error: 'Assign every guest to a room for the hotel rooming list.' };
  }
  return {
    data: {
      guests: input.guests.map((guest, index) => ({
        fullName: guest.full_name,
        travellerType: guest.traveller_type,
        age: travellerTypeByValue.get(guest.traveller_type).minAge == null ? null : guest.age,
        nationality: guest.nationality,
        roomNumber: guest.room_number,
        lead: index === input.lead_guest_index,
      })),
      arrival: { date: input.arrival_date, time: input.arrival_time, details: input.arrival_details },
      departure: { date: input.departure_date, time: input.departure_time, details: input.departure_details },
      specialRequests: input.special_requests,
    },
  };
}

// The award id is sealed inside the ciphertext so a record copied onto another booking fails to open.
export function sealGuestDetails(awardId, details, key) {
  return encryptSecret(JSON.stringify({ awardId, ...details }), key);
}

export function openGuestDetails(awardId, ciphertext, key) {
  const { awardId: sealedFor, ...details } = JSON.parse(decryptSecret(ciphertext, key));
  if (sealedFor !== awardId) throw new Error('Guest details do not belong to this booking.');
  return details;
}

export function guestAccessWindow(tripEndDate, { sellerAccessDays, retentionDays }, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const deletionDueOn = addDays(tripEndDate, retentionDays);
  const sellerAccessEndsOn = addDays(tripEndDate, Math.min(sellerAccessDays, retentionDays));
  return { sellerAccessEndsOn, deletionDueOn, sellerAccessOpen: today < sellerAccessEndsOn };
}
