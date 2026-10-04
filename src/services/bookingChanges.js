import { z } from 'zod';
import { config } from '../config/index.js';
import { containsContactDetails } from '../utils/contactDetails.js';

const optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);

const proposedChangesSchema = z.object({
  travel_start_date: z.iso.date().optional(),
  travel_end_date: z.iso.date().optional(),
  nights: z.number().int().min(1).max(config.bookingChanges.maxNights).optional(),
  room_count: z.number().int().min(1).max(config.bookingChanges.maxRooms).optional(),
  details: optionalText(500),
}).strict().superRefine((changes, context) => {
  const hasStart = changes.travel_start_date != null;
  const hasEnd = changes.travel_end_date != null;
  if (hasStart !== hasEnd) context.addIssue({ code: 'custom', message: 'Provide both new travel dates.', path: ['travel_end_date'] });
  if ((hasStart || hasEnd) && changes.nights == null) context.addIssue({ code: 'custom', message: 'Provide the number of nights with new travel dates.', path: ['nights'] });
  if (hasStart && hasEnd && changes.travel_end_date <= changes.travel_start_date) context.addIssue({ code: 'custom', message: 'Departure must be after arrival.', path: ['travel_end_date'] });
  if (hasStart && hasEnd && changes.nights != null) {
    const days = (Date.parse(`${changes.travel_end_date}T00:00:00Z`) - Date.parse(`${changes.travel_start_date}T00:00:00Z`)) / 86400000;
    if (days !== changes.nights) context.addIssue({ code: 'custom', message: 'Nights must match the proposed travel dates.', path: ['nights'] });
  }
  if (!Object.values(changes).some((value) => value != null)) context.addIssue({ code: 'custom', message: 'Describe at least one booking change.', path: [] });
  if (containsContactDetails(changes.details)) context.addIssue({ code: 'custom', message: 'Remove contact details and external links.', path: ['details'] });
});

export const bookingChangeSchema = z.object({
  change_type: z.enum(['amendment', 'cancellation']),
  message: z.string().trim().min(5, 'Explain the requested change (at least 5 characters).').max(1000),
  proposed_changes: proposedChangesSchema.nullish().transform((value) => value ?? {}),
}).superRefine((input, context) => {
  if (input.change_type === 'amendment' && !Object.values(input.proposed_changes).some((value) => value != null)) {
    context.addIssue({ code: 'custom', message: 'Provide the proposed booking changes.', path: ['proposed_changes'] });
  }
  if (input.change_type === 'cancellation' && Object.values(input.proposed_changes).some((value) => value != null)) {
    context.addIssue({ code: 'custom', message: 'Cancellation requests cannot include amendment fields.', path: ['proposed_changes'] });
  }
  if (containsContactDetails(input.message)) context.addIssue({ code: 'custom', message: 'Remove contact details and external links.', path: ['message'] });
});

export const bookingChangeResponseSchema = z.object({
  note: optionalText(1000),
}).refine((input) => !containsContactDetails(input.note), 'Remove contact details and external links.');

export function bookingChangeDto(row, viewerOrganizationId) {
  return {
    id: row.id,
    awardId: row.award_id,
    initiatedByOrganizationId: row.initiated_by_organization_id,
    isMine: row.initiated_by_organization_id === viewerOrganizationId,
    type: row.change_type,
    proposedChanges: row.proposed_changes,
    message: row.message,
    status: row.status,
    responseNote: row.response_note ?? null,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? null,
  };
}

export async function loadBookingChanges(db, awardIds, viewerOrganizationId) {
  if (!awardIds.length) return new Map();
  const result = await db.query(
    `SELECT * FROM booking_change_requests WHERE award_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [awardIds],
  );
  const grouped = new Map();
  for (const row of result.rows) grouped.set(row.award_id, [...(grouped.get(row.award_id) ?? []), bookingChangeDto(row, viewerOrganizationId)]);
  return grouped;
}