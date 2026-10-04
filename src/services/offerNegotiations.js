import { z } from 'zod';
import { negotiationKinds } from '../config/referenceData.js';
import { containsContactDetails } from '../utils/contactDetails.js';

const optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);
const contactIssue = 'Remove contact details and external links.';

export const negotiationSchema = z.object({
  kind: z.enum(negotiationKinds.map((kind) => kind.value), { error: 'Choose a revision request or a counter-offer.' }),
  message: optionalText(1000),
  counter_price_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish().transform((value) => value ?? null),
  offer_option_id: z.uuid('Choose a valid offer option.').nullish().transform((value) => value ?? null),
}).superRefine((input, context) => {
  const issue = (message, path) => context.addIssue({ code: 'custom', message, path: [path] });
  if (input.kind === 'counter_offer' && input.counter_price_minor == null) issue('Enter your counter price.', 'counter_price_minor');
  if (input.kind === 'revision_request' && input.counter_price_minor != null) issue('A revision request has no price. Send a counter-offer instead.', 'counter_price_minor');
  if (input.kind === 'revision_request' && (input.message ?? '').length < 5) issue('Tell the seller what to change (at least 5 characters).', 'message');
  if (containsContactDetails(input.message)) issue(contactIssue, 'message');
});

export const declineSchema = z.object({
  note: z.string().trim().min(5, 'Give the agency a reason (at least 5 characters).').max(1000),
}).refine((input) => !containsContactDetails(input.note), contactIssue);

export function negotiationDto(row) {
  return {
    id: row.id,
    offerId: row.offer_id,
    kind: row.kind,
    message: row.message,
    counterPriceMinor: row.counter_price_minor == null ? null : Number(row.counter_price_minor),
    currency: row.currency,
    offerKind: row.offer_kind,
    offerOptionId: row.offer_option_id ?? null,
    optionLabel: row.option_label ?? null,
    status: row.status,
    responseNote: row.response_note ?? null,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? null,
  };
}

const negotiationSelect = `SELECT n.*, f.currency, f.offer_kind FROM offer_negotiations n JOIN offers f ON f.id = n.offer_id`;

export async function loadOpenNegotiations(db, offerIds) {
  if (!offerIds.length) return new Map();
  const result = await db.query(`${negotiationSelect} WHERE n.offer_id = ANY($1::uuid[]) AND n.status = 'open'`, [offerIds]);
  return new Map(result.rows.map((row) => [row.offer_id, negotiationDto(row)]));
}

export async function listNegotiations(db, offerId) {
  const result = await db.query(`${negotiationSelect} WHERE n.offer_id = $1 ORDER BY n.created_at DESC`, [offerId]);
  return result.rows.map(negotiationDto);
}
