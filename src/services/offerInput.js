import { z } from 'zod';
import { config, isCurrencyCode } from '../config/index.js';
import { hotelCategories, mealPlans, offerInclusions, offerLineItemTypes } from '../config/referenceData.js';
import { containsContactDetails } from '../utils/contactDetails.js';

const values = (list) => list.map((item) => item.value);
const dayMs = 24 * 60 * 60 * 1000;
const minorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveMinorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uniqueList = (options) => z.array(z.enum(values(options))).max(options.length).default([]).transform((items) => [...new Set(items)]);
const optionalText = (max) => z.string().trim().max(max).nullish().transform((value) => value || null);
const hotelCategoryValues = new Set(values(hotelCategories));
const hotelCategory = z.number().int().refine((value) => hotelCategoryValues.has(value), 'Choose a supported hotel category.').nullish().transform((value) => value ?? null);
const mealPlan = z.enum(values(mealPlans)).nullish().transform((value) => value ?? null);
const optionLabel = z.string().trim().min(1, 'Give each option a name, for example "5 star upgrade".').max(80);

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
  option_label: optionLabel.nullish().transform((value) => value ?? null),
};

const roomType = z.string().trim().min(1, 'Enter a room type.').max(120);
const landOptionSchema = z.object({ label: optionLabel, hotel_category: hotelCategory, total_minor: positiveMinorAmount, notes: optionalText(500) });
const hotelOptionSchema = z.object({ label: optionLabel, room_type: roomType, rate_per_night_minor: positiveMinorAmount, meal_plan: mealPlan, notes: optionalText(500) });
const optionList = (schema) => z.array(schema).max(config.maxOfferOptions, `Add at most ${config.maxOfferOptions} alternative options.`).default([]);

const noContactDetails = (offer) => !containsContactDetails(
  offer.cancellation_policy, offer.payment_notes, offer.option_label,
  ...(offer.line_items ?? []).map((item) => item.description),
  ...offer.options.flatMap((option) => [option.label, option.notes]),
);

// Option names must tell the agency apart which price it is awarding.
const distinctOptionLabels = (offer) => {
  if (!offer.options.length) return true;
  const labels = [offer.option_label, ...offer.options.map((option) => option.label)].filter(Boolean).map((label) => label.toLocaleLowerCase());
  return Boolean(offer.option_label) && new Set(labels).size === labels.length;
};
const distinctLabelsIssue = { message: 'Name the main option and give every option a different name.', path: ['options'] };

export const landPackageOfferSchema = z.object({
  ...commonFields,
  total_minor: positiveMinorAmount,
  hotel_category: hotelCategory,
  line_items: z.array(lineItemSchema).max(config.maxOfferLineItems, `Use at most ${config.maxOfferLineItems} line items.`).default([]),
  options: optionList(landOptionSchema),
}).refine((offer) => !offer.line_items.length || offer.line_items.reduce((sum, item) => sum + item.line_total_minor, 0) === offer.total_minor, {
  message: 'Line items must add up exactly to the offer total.',
  path: ['line_items'],
}).refine(distinctOptionLabels, distinctLabelsIssue)
  .refine(noContactDetails, 'Remove contact details and external links from offer text.');

export const hotelRoomOfferSchema = z.object({
  ...commonFields,
  rate_per_night_minor: positiveMinorAmount,
  room_type: roomType,
  meal_plan: mealPlan,
  room_count: z.number().int().min(1).max(50).nullish().transform((value) => value ?? null),
  taxes_included: z.boolean().nullish().transform((value) => value ?? null),
  availability_confirmed: z.boolean().default(false),
  options: optionList(hotelOptionSchema),
}).refine(distinctOptionLabels, distinctLabelsIssue)
  .refine(noContactDetails, 'Remove contact details and external links from offer text.');

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

export async function replaceOptions(client, offerId, options, randomId) {
  await client.query('DELETE FROM offer_options WHERE offer_id = $1', [offerId]);
  for (const [index, option] of options.entries()) {
    await client.query(
      `INSERT INTO offer_options (id, offer_id, position, label, hotel_category, total_minor, rate_per_night_minor, room_type, meal_plan, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomId(), offerId, index + 1, option.label, option.hotel_category ?? null, option.total_minor ?? null,
        option.rate_per_night_minor ?? null, option.room_type ?? null, option.meal_plan ?? null, option.notes ?? null],
    );
  }
}

export async function loadOptions(db, offerIds) {
  if (!offerIds.length) return new Map();
  const result = await db.query(
    `SELECT id, offer_id, label, hotel_category, total_minor, rate_per_night_minor, room_type, meal_plan, notes
     FROM offer_options WHERE offer_id = ANY($1::uuid[]) ORDER BY offer_id, position`,
    [offerIds],
  );
  const byOffer = new Map();
  for (const row of result.rows) byOffer.set(row.offer_id, [...(byOffer.get(row.offer_id) ?? []), row]);
  return byOffer;
}

// Alternatives share the main offer's terms, so pricing reuses the offer row with the option's price.
export function offerOptionDto(option, offerRow, request) {
  const minor = (value) => value == null ? null : Number(value);
  return {
    id: option.id,
    label: option.label,
    hotelCategory: option.hotel_category ?? null,
    totalMinor: minor(option.total_minor),
    ratePerNightMinor: minor(option.rate_per_night_minor),
    roomType: option.room_type ?? null,
    mealPlan: option.meal_plan ?? null,
    notes: option.notes ?? null,
    ...(request ? offerPricingDto({ ...offerRow, total_minor: option.total_minor, rate_per_night_minor: option.rate_per_night_minor }, request) : {}),
  };
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
