import { z } from 'zod';
import { config, isCurrencyCode } from '../config/index.js';
import { mealPlans, offerInclusions, offerLineItemTypes } from '../config/referenceData.js';
import { containsContactDetails } from '../utils/contactDetails.js';

const values = (list) => list.map((item) => item.value);
const dayMs = 24 * 60 * 60 * 1000;
const minorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveMinorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uniqueList = (options) => z.array(z.enum(values(options))).max(options.length).default([]).transform((items) => [...new Set(items)]);
const optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);

const lineItemSchema = z.object({
  item_type: z.enum(values(offerLineItemTypes), { error: 'Choose a supported line item type.' }),
  description: z.string().trim().min(2, 'Each line item needs a description.').max(200),
  quantity: z.number().int().positive().max(10000),
  unit_price_minor: minorAmount,
}).transform((item) => ({ ...item, line_total_minor: item.quantity * item.unit_price_minor }))
  .refine((item) => Number.isSafeInteger(item.line_total_minor), 'A line item total is too large.');

const commonFields = {
  currency: z.string().toUpperCase().refine(isCurrencyCode, 'Use an ISO 4217 currency code.'),
  inclusions: uniqueList(offerInclusions),
  exclusions: uniqueList(offerInclusions),
  validity_until: z.iso.datetime({ offset: true, error: 'Offer validity must be a date and time.' })
    .transform((value) => new Date(value))
    .refine((value) => value > new Date() && value <= new Date(Date.now() + config.offerValidity.maxDays * dayMs), `Offer validity must be in the future and within ${config.offerValidity.maxDays} days.`),
  cancellation_policy: optionalText(1000),
  free_cancellation_until: z.iso.date().nullish().transform((value) => value ?? null),
  deposit_percent: z.number().int().min(0).max(100).nullish().transform((value) => value ?? null),
  balance_due_days_before_travel: z.number().int().min(0).max(365).nullish().transform((value) => value ?? null),
  payment_notes: optionalText(500),
};

const noContactDetails = (offer) => !containsContactDetails(offer.cancellation_policy, offer.payment_notes, ...(offer.line_items ?? []).map((item) => item.description));

export const landPackageOfferSchema = z.object({
  ...commonFields,
  total_minor: positiveMinorAmount,
  line_items: z.array(lineItemSchema).max(config.maxOfferLineItems, `Use at most ${config.maxOfferLineItems} line items.`).default([]),
}).refine((offer) => !offer.line_items.length || offer.line_items.reduce((sum, item) => sum + item.line_total_minor, 0) === offer.total_minor, {
  message: 'Line items must add up exactly to the offer total.',
  path: ['line_items'],
}).refine(noContactDetails, 'Remove contact details and external links from offer text.');

export const hotelRoomOfferSchema = z.object({
  ...commonFields,
  rate_per_night_minor: positiveMinorAmount,
  room_type: z.string().trim().min(1, 'Enter a room type.').max(120),
  meal_plan: z.enum(values(mealPlans)).nullish().transform((value) => value ?? null),
  room_count: z.number().int().min(1).max(50).nullish().transform((value) => value ?? null),
  taxes_included: z.boolean().nullish().transform((value) => value ?? null),
  availability_confirmed: z.boolean().default(false),
}).refine(noContactDetails, 'Remove contact details and external links from offer text.');

export function offerSchemaFor(kind) {
  return kind === 'hotel_room' ? hotelRoomOfferSchema : landPackageOfferSchema;
}

export async function replaceLineItems(client, offerId, lineItems, randomId) {
  await client.query('DELETE FROM offer_line_items WHERE offer_id = $1', [offerId]);
  for (const [index, item] of lineItems.entries()) {
    await client.query(
      `INSERT INTO offer_line_items (id, offer_id, position, item_type, description, quantity, unit_price_minor, line_total_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomId(), offerId, index + 1, item.item_type, item.description, item.quantity, item.unit_price_minor, item.line_total_minor],
    );
  }
}

export async function loadLineItems(db, offerIds) {
  if (!offerIds.length) return new Map();
  const result = await db.query(
    `SELECT offer_id, item_type, description, quantity, unit_price_minor, line_total_minor
     FROM offer_line_items WHERE offer_id = ANY($1::uuid[]) ORDER BY offer_id, position`,
    [offerIds],
  );
  const byOffer = new Map();
  for (const row of result.rows) {
    const items = byOffer.get(row.offer_id) ?? [];
    items.push({ type: row.item_type, description: row.description, quantity: row.quantity, unitPriceMinor: Number(row.unit_price_minor), lineTotalMinor: Number(row.line_total_minor) });
    byOffer.set(row.offer_id, items);
  }
  return byOffer;
}

export function offerTermsDto(row) {
  const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null;
  return {
    cancellationPolicy: row.cancellation_policy ?? null,
    freeCancellationUntil: dateText(row.free_cancellation_until),
    depositPercent: row.deposit_percent ?? null,
    balanceDueDaysBeforeTravel: row.balance_due_days_before_travel ?? null,
    paymentNotes: row.payment_notes ?? null,
    roomCount: row.room_count ?? null,
    taxesIncluded: row.taxes_included ?? null,
    availabilityConfirmed: row.availability_confirmed ?? null,
  };
}

// Per-traveller price uses paying travellers (adults and children); infants are excluded.
export function offerPricingDto(row, request) {
  const travellers = Number(request.adults) + Number(request.children ?? 0);
  const estimatedTotalMinor = row.offer_kind === 'hotel_room'
    ? Number(row.rate_per_night_minor) * Number(request.nights) * Number(row.room_count ?? request.room_count ?? 1)
    : Number(row.total_minor);
  return {
    estimatedTotalMinor,
    perTravellerMinor: travellers > 0 ? Math.round(estimatedTotalMinor / travellers) : null,
    travellers,
  };
}
