export const defaultMaxOffersPerRequest = 10;
export const maxOffersPerRequestBounds = { min: 1, max: 50 };

export async function getMaxOffersPerRequest(db) {
  const result = await db.query("SELECT setting_value FROM platform_settings WHERE setting_key = 'max_offers_per_request'");
  const value = Number(result.rows[0]?.setting_value);
  return Number.isInteger(value) && value >= maxOffersPerRequestBounds.min && value <= maxOffersPerRequestBounds.max
    ? value
    : defaultMaxOffersPerRequest;
}
