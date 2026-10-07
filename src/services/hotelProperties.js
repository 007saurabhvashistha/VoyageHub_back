import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/index.js';
import { hotelCategories, hotelFacilities, mealPlans } from '../config/referenceData.js';
import { destinationDto, findDestination, resolveActiveDestinations } from './destinations.js';
import { getSetting } from './platformSettings.js';
import { notify, pruneSellerTargets, retargetSeller } from './routing.js';

// A hotel is located precisely: at a place or, when the place is not listed, its district.
export const propertyDestinationKinds = ['city', 'district'];
const starValues = hotelCategories.map((item) => item.value);

export const propertyInputSchema = z.object({
  name: z.string().trim().min(2, 'Enter the hotel name (2 to 160 characters).').max(160, 'Enter the hotel name (2 to 160 characters).'),
  destination_id: z.uuid('Choose where the hotel is located from the destination list.'),
  star_category: z.coerce.number().int().refine((value) => starValues.includes(value), 'Choose a supported star category.').nullish().transform((value) => value ?? null),
  room_count: z.coerce.number().int().min(1, 'Rooms must be between 1 and 5000.').max(5000, 'Rooms must be between 1 and 5000.').nullish().transform((value) => value ?? null),
  room_types: z.array(z.string().trim().min(2).max(120)).max(config.hotels.maxRoomTypes).default([]).transform((items) => [...new Set(items)]),
  meal_plans: z.array(z.enum(mealPlans.map((item) => item.value))).max(mealPlans.length).default([]).transform((items) => [...new Set(items)]),
  facilities: z.array(z.enum(hotelFacilities.map((item) => item.value))).max(hotelFacilities.length).default([]).transform((items) => [...new Set(items)]),
});

export const propertyUpdateSchema = propertyInputSchema.partial().extend({
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Change at least one field.');

export async function propertyDto(db, row, { photos = null } = {}) {
  const destination = await findDestination(db, row.destination_id);
  const photoRows = photos ?? (await db.query(
    'SELECT id, original_filename, content_type, size_bytes, scan_status, created_at FROM hotel_property_photos WHERE property_id = $1 AND deleted_at IS NULL ORDER BY created_at, id',
    [row.id],
  )).rows;
  return {
    id: row.id,
    name: row.name,
    destination: destination ? destinationDto(destination) : null,
    starCategory: row.star_category,
    roomCount: row.room_count,
    roomTypes: row.room_types ?? [],
    mealPlans: row.meal_plans ?? [],
    facilities: row.facilities ?? [],
    ownershipCheckStatus: row.ownership_check_status ?? 'pending',
    photos: photoRows.map((photo) => ({ id: photo.id, filename: photo.original_filename, contentType: photo.content_type, sizeBytes: photo.size_bytes, scanStatus: photo.scan_status, createdAt: photo.created_at })),
    active: row.active,
    verificationStatus: row.verification_status,
    verificationReason: row.verification_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProperties(db, organizationId) {
  const result = await db.query('SELECT * FROM hotel_properties WHERE organization_id = $1 ORDER BY created_at, id', [organizationId]);
  const photos = result.rowCount ? await db.query(
    'SELECT id, property_id, original_filename, content_type, size_bytes, scan_status, created_at FROM hotel_property_photos WHERE property_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at, id',
    [result.rows.map((row) => row.id)],
  ) : { rows: [] };
  const photosByProperty = new Map();
  for (const photo of photos.rows) photosByProperty.set(photo.property_id, [...(photosByProperty.get(photo.property_id) ?? []), photo]);
  const properties = [];
  for (const row of result.rows) properties.push(await propertyDto(db, row, { photos: photosByProperty.get(row.id) ?? [] }));
  return properties;
}

async function validatePropertyDestination(db, destinationId) {
  const resolved = await resolveActiveDestinations(db, [destinationId], { kinds: propertyDestinationKinds });
  return resolved.error ? { error: resolved.error } : { destination: resolved.rows[0] };
}

async function sellerApproved(db, organizationId) {
  const result = await db.query('SELECT verification_status FROM seller_profiles WHERE organization_id = $1', [organizationId]);
  return result.rows[0]?.verification_status === 'approved';
}

// Keeps seller_profiles' legacy single-property columns pointing at the first active hotel.
async function syncPrimaryProperty(db, organizationId) {
  await db.query(
    `UPDATE seller_profiles p SET property_destination_id = first.destination_id, property_city = first.city_name
     FROM (SELECT h.destination_id, d.name AS city_name FROM hotel_properties h JOIN destinations d ON d.id = h.destination_id
           WHERE h.organization_id = $1 AND h.active ORDER BY h.created_at, h.id LIMIT 1) first
     WHERE p.organization_id = $1`,
    [organizationId],
  );
}

export async function createProperty(client, { organizationId, input }) {
  const limit = await getSetting(client, 'max_hotel_properties_per_organization');
  const count = await client.query('SELECT COUNT(*) AS total FROM hotel_properties WHERE organization_id = $1 AND active', [organizationId]);
  if (Number(count.rows[0].total) >= limit) return { status: 409, code: 'PROPERTY_LIMIT_REACHED', error: `A hotel account can list up to ${limit} active hotels.` };
  const location = await validatePropertyDestination(client, input.destination_id);
  if (location.error) return { status: 400, code: 'VALIDATION_ERROR', error: location.error };
  const result = await client.query(
    `INSERT INTO hotel_properties (id, organization_id, name, destination_id, star_category, room_count, room_types, meal_plans, facilities)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [randomUUID(), organizationId, input.name, input.destination_id, input.star_category, input.room_count, input.room_types, input.meal_plans, input.facilities],
  );
  await syncPrimaryProperty(client, organizationId);
  return { property: result.rows[0] };
}

// Moving a hotel needs a new review; deactivating removes it from leads it no longer matches.
export async function updateProperty(client, { organizationId, propertyId, input }) {
  const current = await client.query('SELECT * FROM hotel_properties WHERE id = $1 AND organization_id = $2 FOR UPDATE', [propertyId, organizationId]);
  if (!current.rowCount) return { status: 404, code: 'PROPERTY_NOT_FOUND', error: 'Hotel was not found.' };
  const row = current.rows[0];
  const moved = input.destination_id != null && input.destination_id !== row.destination_id;
  if (moved) {
    const location = await validatePropertyDestination(client, input.destination_id);
    if (location.error) return { status: 400, code: 'VALIDATION_ERROR', error: location.error };
  }
  if (input.active === true && !row.active) {
    const limit = await getSetting(client, 'max_hotel_properties_per_organization');
    const count = await client.query('SELECT COUNT(*) AS total FROM hotel_properties WHERE organization_id = $1 AND active', [organizationId]);
    if (Number(count.rows[0].total) >= limit) return { status: 409, code: 'PROPERTY_LIMIT_REACHED', error: `A hotel account can list up to ${limit} active hotels.` };
  }
  const updated = await client.query(
    `UPDATE hotel_properties SET
       name = COALESCE($3, name), destination_id = COALESCE($4, destination_id),
       star_category = CASE WHEN $5::boolean THEN $6 ELSE star_category END,
       room_count = CASE WHEN $7::boolean THEN $8 ELSE room_count END,
      room_types = CASE WHEN $9::boolean THEN $10 ELSE room_types END,
      meal_plans = CASE WHEN $11::boolean THEN $12 ELSE meal_plans END,
      facilities = CASE WHEN $13::boolean THEN $14 ELSE facilities END,
      active = COALESCE($15, active),
      verification_status = CASE WHEN $16::boolean THEN 'pending' ELSE verification_status END,
      ownership_check_status = CASE WHEN $16::boolean THEN 'pending' ELSE ownership_check_status END,
      verification_reason = CASE WHEN $16::boolean THEN 'Hotel location changed and requires a new review.' ELSE verification_reason END,
       updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [propertyId, organizationId, input.name ?? null, moved ? input.destination_id : null,
      Object.hasOwn(input, 'star_category'), input.star_category ?? null,
      Object.hasOwn(input, 'room_count'), input.room_count ?? null,
      Object.hasOwn(input, 'room_types'), input.room_types ?? null,
      Object.hasOwn(input, 'meal_plans'), input.meal_plans ?? null,
      Object.hasOwn(input, 'facilities'), input.facilities ?? null,
      input.active ?? null, moved],
  );
  await syncPrimaryProperty(client, organizationId);
  const lostArea = moved || (input.active === false && row.active);
  if (lostArea) await pruneSellerTargets(client, organizationId, 'Your hotel in this area was moved or deactivated.');
  if (input.active === true && !row.active && row.verification_status === 'approved' && await sellerApproved(client, organizationId)) await retargetSeller(client, organizationId);
  return { property: updated.rows[0] };
}

export async function decideProperty(client, { propertyId, decision, reason, reviewerId }) {
  const result = await client.query(
     `UPDATE hotel_properties SET verification_status = $2::varchar, verification_reason = $3,
       ownership_check_status = CASE WHEN $2::varchar = 'approved' THEN 'verified' ELSE 'rejected' END,
       reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND verification_status = 'pending' RETURNING *`,
    [propertyId, decision, reason, reviewerId],
  );
  if (!result.rowCount) return null;
  const property = result.rows[0];
  await notify(client, property.organization_id, 'hotel_property_reviewed', decision === 'approved' ? 'Hotel approved' : 'Hotel not approved',
    `${property.name} / ${reason}`, { propertyId: property.id, decision });
  if (decision === 'approved' && property.active && await sellerApproved(client, property.organization_id)) await retargetSeller(client, property.organization_id);
  return property;
}
