import countries from 'i18n-iso-countries';
import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));

export function isCountryCode(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && countries.isValid(value);
}

export function isCurrencyCode(value) {
  return typeof value === 'string' && supportedCurrencies.has(value);
}

const positiveInt = (fallback) => z.coerce.number().int().positive().default(fallback);
const optionalText = (max) => z.string().trim().min(1).max(max).optional();
const mimeTypeList = z.string().transform((value) => value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'DOCUMENT_ALLOWED_MIME_TYPES must be a comma-separated list of MIME types')).min(1));
const textList = (pattern, message) => z.string().transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(pattern, message)));

const envSchema = z.object({
  EMAIL_VERIFICATION_REQUIRED: z.stringbool().default(true),
  DEFAULT_COUNTRY: z.string().toUpperCase().refine(isCountryCode, 'DEFAULT_COUNTRY must be an ISO 3166-1 alpha-2 code').default('IN'),
  DEFAULT_CURRENCY: z.string().toUpperCase().refine(isCurrencyCode, 'DEFAULT_CURRENCY must be an ISO 4217 code').default('INR'),
  COMPARISON_RATE_API_URL: z.url().refine((value) => new URL(value).protocol === 'https:', 'COMPARISON_RATE_API_URL must use HTTPS').default('https://api.frankfurter.dev/v2'),
  COMPARISON_RATE_TIMEOUT_MS: positiveInt(5000),
  COMPARISON_RATE_CACHE_SECONDS: positiveInt(3600),
  MAX_INVITED_SUPPLIERS: positiveInt(20),
  REQUEST_DEADLINE_MIN_HOURS: positiveInt(1),
  REQUEST_DEADLINE_DEFAULT_HOURS: positiveInt(72),
  REQUEST_DEADLINE_MAX_DAYS: positiveInt(90),
  OFFER_VALIDITY_DEFAULT_DAYS: positiveInt(5),
  OFFER_VALIDITY_MAX_DAYS: positiveInt(90),
  INVITATION_TTL_HOURS: positiveInt(168),
  MAX_PENDING_INVITATIONS: positiveInt(50),
  MAX_OFFER_LINE_ITEMS: positiveInt(50),
  MAX_OFFER_OPTIONS: positiveInt(3),
  MAX_NEGOTIATION_ROUNDS_PER_OFFER: positiveInt(5),
  MAX_AWARDS_PER_REQUEST: positiveInt(3),
  AWARD_UNDO_WINDOW_MINUTES: positiveInt(15),
  BOOKING_CHANGE_MAX_NIGHTS: positiveInt(90),
  BOOKING_CHANGE_MAX_ROOMS: positiveInt(50),
  REMINDER_DEADLINE_HOURS: positiveInt(24),
  REMINDER_OFFER_EXPIRY_HOURS: positiveInt(48),
  REMINDER_JOB_INTERVAL_SECONDS: positiveInt(300),
  DEADLINE_JOB_INTERVAL_SECONDS: positiveInt(60),
  AUTH_RATE_LIMIT_WINDOW_MINUTES: positiveInt(15),
  AUTH_RATE_LIMIT_MAX: positiveInt(10),
  EMAIL_ACTION_RATE_LIMIT_WINDOW_MINUTES: positiveInt(60),
  EMAIL_ACTION_RATE_LIMIT_MAX: positiveInt(5),
  MFA_RATE_LIMIT_MAX: positiveInt(10),
  INVITATION_RATE_LIMIT_PER_HOUR: positiveInt(30),
  REPORT_RATE_LIMIT_PER_HOUR: positiveInt(20),
  SESSION_LIFETIME_HOURS: positiveInt(336),
  MFA_CHALLENGE_TTL_MINUTES: positiveInt(5),
  MAX_COVERAGE_DESTINATIONS: positiveInt(20),
  DESTINATION_SEARCH_LIMIT: positiveInt(20),
  DESTINATION_CHILDREN_LIMIT: positiveInt(500),
  DESTINATION_SEARCH_RATE_LIMIT_PER_MINUTE: positiveInt(120),
  ACCOUNT_DELETION_GRACE_DAYS: positiveInt(30),
  UNVERIFIED_ACCOUNT_RETENTION_DAYS: positiveInt(30),
  RETENTION_JOB_INTERVAL_SECONDS: positiveInt(3600),
  ACCOUNT_EXPORT_RATE_LIMIT_PER_HOUR: positiveInt(5),
  GEONAMES_DUMP_URL: z.url().default('https://download.geonames.org/export/dump'),
  GEONAMES_CITIES_DATASET: z.enum(['cities500', 'cities1000', 'cities5000', 'cities15000']).default('cities15000'),
  // Defaults for admin-editable platform settings; the database value wins once an admin sets it.
  DESTINATION_COUNTRIES: textList(/^[A-Z]{2}$/, 'DESTINATION_COUNTRIES must be comma-separated ISO country codes').default([]),
  GEONAMES_PLACE_FEATURE_CODES: textList(/^[A-Z0-9]{1,10}$/, 'GEONAMES_PLACE_FEATURE_CODES must be comma-separated GeoNames feature codes')
    .default(['PRK', 'RES', 'RESN', 'RESW', 'LK', 'ISL', 'PASS', 'BCH', 'WTRF', 'ANS', 'MNMT', 'FT', 'CSTL', 'PAL', 'CAVE', 'VAL', 'HSTS']),
  GEONAMES_ALIAS_LANGUAGES: textList(/^[a-z]{0,8}$/, 'GEONAMES_ALIAS_LANGUAGES must be comma-separated language codes').default(['en', 'abbr']),
  GEONAMES_EXCLUDED_FEATURE_CODES: textList(/^[A-Z0-9]{1,10}$/, 'GEONAMES_EXCLUDED_FEATURE_CODES must be comma-separated GeoNames feature codes').default(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']),
  GEONAMES_MIN_PLACE_POPULATION: z.coerce.number().int().min(0).default(5000),
  GEONAMES_MAX_ALIASES: positiveInt(15),
  HOTEL_LEAD_ALLOWED_DESTINATION_KINDS: textList(/^(region|district|city)$/, 'HOTEL_LEAD_ALLOWED_DESTINATION_KINDS may contain region, district and city').default(['region', 'district', 'city']),
  MAX_REQUEST_DESTINATIONS: positiveInt(10),
  MAX_OFFERS_PER_HOTEL_ORG_PER_REQUEST: positiveInt(3),
  MAX_INSTANT_ALERTS_PER_REQUEST: positiveInt(200),
  DIGEST_SEND_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  MAX_HOTEL_PROPERTIES_PER_ORGANIZATION: positiveInt(100),
  ALERT_DIGEST_JOB_INTERVAL_SECONDS: positiveInt(600),
  FEATURED_IMPORT_MAX_ROWS: positiveInt(2000),
  LEGAL_ENTITY_NAME: optionalText(200),
  GRIEVANCE_OFFICER_NAME: optionalText(120),
  GRIEVANCE_OFFICER_EMAIL: z.email().optional(),
  GRIEVANCE_OFFICER_PHONE: optionalText(40),
  GRIEVANCE_OFFICER_ADDRESS: optionalText(500),
  STORAGE_PROVIDER: z.enum(['s3', 'azure']).optional(),
  STORAGE_KEY_PREFIX: z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]{0,99}$/, 'STORAGE_KEY_PREFIX may use lowercase letters, digits, /, _ and -').default('verification-documents'),
  S3_BUCKET: optionalText(255),
  S3_REGION: optionalText(64),
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  S3_ACCESS_KEY_ID: optionalText(256),
  S3_SECRET_ACCESS_KEY: optionalText(256),
  S3_SERVER_SIDE_ENCRYPTION: z.enum(['AES256', 'aws:kms']).optional(),
  S3_KMS_KEY_ID: optionalText(2048),
  AZURE_STORAGE_CONTAINER: optionalText(63),
  AZURE_STORAGE_CONNECTION_STRING: optionalText(4096),
  AZURE_STORAGE_ACCOUNT_NAME: optionalText(64),
  AZURE_STORAGE_ACCOUNT_KEY: optionalText(256),
  AZURE_STORAGE_ENDPOINT: z.url().optional(),
  MALWARE_SCANNER: z.enum(['clamav']).optional(),
  CLAMAV_HOST: optionalText(255),
  CLAMAV_PORT: positiveInt(3310),
  CLAMAV_SOCKET: optionalText(255),
  CLAMAV_TIMEOUT_MS: positiveInt(60000),
  DOCUMENT_MAX_MB: positiveInt(10),
  DOCUMENT_ALLOWED_MIME_TYPES: mimeTypeList.default(['application/pdf', 'image/jpeg', 'image/png']),
  DOCUMENT_MAX_PER_ORGANIZATION: positiveInt(40),
  DOCUMENT_UPLOAD_RATE_LIMIT_PER_HOUR: positiveInt(30),
  DOCUMENT_DOWNLOAD_URL_TTL_SECONDS: positiveInt(300),
  DOCUMENT_SCAN_JOB_INTERVAL_SECONDS: positiveInt(30),
  DOCUMENT_SCAN_MAX_ATTEMPTS: positiveInt(8),
  REJECTED_DOCUMENT_RETENTION_DAYS: positiveInt(90),
  CLOSED_ORGANIZATION_DOCUMENT_RETENTION_DAYS: positiveInt(365),
  GUEST_DATA_SELLER_ACCESS_DAYS: positiveInt(30),
  GUEST_DATA_RETENTION_DAYS: positiveInt(90),
  GUEST_DETAILS_VIEW_RATE_LIMIT_PER_HOUR: positiveInt(120),
  BOOKING_VOUCHER_MAX_PER_BOOKING: positiveInt(5),
  BOOKING_VOUCHER_KEY_PREFIX: z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]{0,99}$/, 'BOOKING_VOUCHER_KEY_PREFIX may use lowercase letters, digits, /, _ and -').default('booking-vouchers'),
  MAX_OFFER_ATTACHMENTS: positiveInt(5),
  MAX_MESSAGE_ATTACHMENTS_PER_CONVERSATION: positiveInt(20),
  ATTACHMENT_KEY_PREFIX: z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]{0,99}$/, 'ATTACHMENT_KEY_PREFIX may use lowercase letters, digits, /, _ and -').default('marketplace-attachments'),
  WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION: positiveInt(5),
  WEBHOOK_TIMEOUT_MS: positiveInt(10000),
  WEBHOOK_MAX_ATTEMPTS: positiveInt(10),
  WEBHOOK_RETRY_BASE_SECONDS: positiveInt(30),
  WEBHOOK_RETRY_MAX_MINUTES: positiveInt(720),
  WEBHOOK_DISABLE_AFTER_FAILURES: positiveInt(30),
  WEBHOOK_SECRET_ROTATION_GRACE_HOURS: positiveInt(24),
  WEBHOOK_DELIVERY_RETENTION_DAYS: positiveInt(30),
  WEBHOOK_JOB_INTERVAL_SECONDS: positiveInt(5),
  WEBHOOK_MANAGE_RATE_LIMIT_PER_HOUR: positiveInt(30),
  WEBHOOK_ALLOW_INSECURE_URLS: z.stringbool().default(false),
  BACKUP_DIRECTORY: z.string().trim().min(1).default('.backups'),
  BACKUP_KEY_PREFIX: z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]{0,99}$/, 'BACKUP_KEY_PREFIX may use lowercase letters, digits, /, _ and -').default('database-backups'),
  BACKUP_MAX_AGE_HOURS: positiveInt(26),
  RESTORE_DRILL_MAX_AGE_DAYS: positiveInt(35),
  PG_BIN_DIRECTORY: optionalText(500),
}).superRefine((env, context) => {
  const missing = (message) => context.addIssue({ code: 'custom', message });
  if (env.STORAGE_PROVIDER === 's3' && (!env.S3_BUCKET || !env.S3_REGION)) missing('STORAGE_PROVIDER=s3 requires S3_BUCKET and S3_REGION.');
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) missing('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default AWS credential chain.');
  if (env.STORAGE_PROVIDER === 'azure' && (!env.AZURE_STORAGE_CONTAINER || !(env.AZURE_STORAGE_CONNECTION_STRING || (env.AZURE_STORAGE_ACCOUNT_NAME && env.AZURE_STORAGE_ACCOUNT_KEY)))) {
    missing('STORAGE_PROVIDER=azure requires AZURE_STORAGE_CONTAINER and either AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME with AZURE_STORAGE_ACCOUNT_KEY.');
  }
  if (env.MALWARE_SCANNER === 'clamav' && !env.CLAMAV_HOST && !env.CLAMAV_SOCKET) missing('MALWARE_SCANNER=clamav requires CLAMAV_HOST or CLAMAV_SOCKET.');
});

function storageConfig(parsed) {
  if (!parsed.STORAGE_PROVIDER) return null;
  return {
    provider: parsed.STORAGE_PROVIDER,
    keyPrefix: parsed.STORAGE_KEY_PREFIX.replace(/\/+$/, ''),
    s3: {
      bucket: parsed.S3_BUCKET,
      region: parsed.S3_REGION,
      endpoint: parsed.S3_ENDPOINT ?? null,
      forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
      credentials: parsed.S3_ACCESS_KEY_ID ? { accessKeyId: parsed.S3_ACCESS_KEY_ID, secretAccessKey: parsed.S3_SECRET_ACCESS_KEY } : null,
      serverSideEncryption: parsed.S3_SERVER_SIDE_ENCRYPTION ?? null,
      kmsKeyId: parsed.S3_KMS_KEY_ID ?? null,
    },
    azure: {
      container: parsed.AZURE_STORAGE_CONTAINER,
      connectionString: parsed.AZURE_STORAGE_CONNECTION_STRING ?? null,
      accountName: parsed.AZURE_STORAGE_ACCOUNT_NAME ?? null,
      accountKey: parsed.AZURE_STORAGE_ACCOUNT_KEY ?? null,
      endpoint: parsed.AZURE_STORAGE_ENDPOINT ?? null,
    },
  };
}

export function loadConfig(env = process.env) {
  const parsed = envSchema.parse(env);
  if (parsed.WEBHOOK_ALLOW_INSECURE_URLS && env.NODE_ENV === 'production') {
    throw new Error('WEBHOOK_ALLOW_INSECURE_URLS must not be enabled in production.');
  }
  return {
    emailVerificationRequired: parsed.EMAIL_VERIFICATION_REQUIRED,
    defaultCountry: parsed.DEFAULT_COUNTRY,
    defaultCurrency: parsed.DEFAULT_CURRENCY,
    comparisonRates: {
      apiUrl: parsed.COMPARISON_RATE_API_URL.replace(/\/+$/, ''),
      timeoutMs: parsed.COMPARISON_RATE_TIMEOUT_MS,
      cacheMs: parsed.COMPARISON_RATE_CACHE_SECONDS * 1000,
    },
    maxInvitedSuppliers: parsed.MAX_INVITED_SUPPLIERS,
    requestDeadline: {
      minHours: parsed.REQUEST_DEADLINE_MIN_HOURS,
      defaultHours: parsed.REQUEST_DEADLINE_DEFAULT_HOURS,
      maxDays: parsed.REQUEST_DEADLINE_MAX_DAYS,
    },
    offerValidity: {
      defaultDays: parsed.OFFER_VALIDITY_DEFAULT_DAYS,
      maxDays: parsed.OFFER_VALIDITY_MAX_DAYS,
    },
    invitationTtlHours: parsed.INVITATION_TTL_HOURS,
    maxPendingInvitations: parsed.MAX_PENDING_INVITATIONS,
    maxOfferLineItems: parsed.MAX_OFFER_LINE_ITEMS,
    maxOfferOptions: parsed.MAX_OFFER_OPTIONS,
    maxNegotiationRoundsPerOffer: parsed.MAX_NEGOTIATION_ROUNDS_PER_OFFER,
    awards: {
      maxPerRequest: parsed.MAX_AWARDS_PER_REQUEST,
      undoWindowMs: parsed.AWARD_UNDO_WINDOW_MINUTES * 60000,
    },
    bookingChanges: {
      maxNights: parsed.BOOKING_CHANGE_MAX_NIGHTS,
      maxRooms: parsed.BOOKING_CHANGE_MAX_ROOMS,
    },
    reminders: {
      deadlineHours: parsed.REMINDER_DEADLINE_HOURS,
      offerExpiryHours: parsed.REMINDER_OFFER_EXPIRY_HOURS,
      intervalMs: parsed.REMINDER_JOB_INTERVAL_SECONDS * 1000,
    },
    deadlineJobIntervalMs: parsed.DEADLINE_JOB_INTERVAL_SECONDS * 1000,
    rateLimits: {
      auth: { windowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60000, limit: parsed.AUTH_RATE_LIMIT_MAX },
      emailAction: { windowMs: parsed.EMAIL_ACTION_RATE_LIMIT_WINDOW_MINUTES * 60000, limit: parsed.EMAIL_ACTION_RATE_LIMIT_MAX },
      mfa: { windowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60000, limit: parsed.MFA_RATE_LIMIT_MAX },
      invitation: { windowMs: 3600000, limit: parsed.INVITATION_RATE_LIMIT_PER_HOUR },
      report: { windowMs: 3600000, limit: parsed.REPORT_RATE_LIMIT_PER_HOUR },
      destinationSearch: { windowMs: 60000, limit: parsed.DESTINATION_SEARCH_RATE_LIMIT_PER_MINUTE },
      accountExport: { windowMs: 3600000, limit: parsed.ACCOUNT_EXPORT_RATE_LIMIT_PER_HOUR },
      documentUpload: { windowMs: 3600000, limit: parsed.DOCUMENT_UPLOAD_RATE_LIMIT_PER_HOUR },
      guestDetailsView: { windowMs: 3600000, limit: parsed.GUEST_DETAILS_VIEW_RATE_LIMIT_PER_HOUR },
      webhookManage: { windowMs: 3600000, limit: parsed.WEBHOOK_MANAGE_RATE_LIMIT_PER_HOUR },
    },
    storage: storageConfig(parsed),
    malwareScanner: parsed.MALWARE_SCANNER
      ? { provider: parsed.MALWARE_SCANNER, host: parsed.CLAMAV_HOST ?? null, port: parsed.CLAMAV_PORT, socket: parsed.CLAMAV_SOCKET ?? null, timeoutMs: parsed.CLAMAV_TIMEOUT_MS }
      : null,
    documents: {
      maxBytes: parsed.DOCUMENT_MAX_MB * 1024 * 1024,
      allowedMimeTypes: parsed.DOCUMENT_ALLOWED_MIME_TYPES,
      maxPerOrganization: parsed.DOCUMENT_MAX_PER_ORGANIZATION,
      downloadUrlTtlSeconds: parsed.DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
      scanIntervalMs: parsed.DOCUMENT_SCAN_JOB_INTERVAL_SECONDS * 1000,
      scanMaxAttempts: parsed.DOCUMENT_SCAN_MAX_ATTEMPTS,
      retention: {
        rejectedDays: parsed.REJECTED_DOCUMENT_RETENTION_DAYS,
        closedOrganizationDays: parsed.CLOSED_ORGANIZATION_DOCUMENT_RETENTION_DAYS,
      },
    },
    bookings: {
      guestData: {
        sellerAccessDays: parsed.GUEST_DATA_SELLER_ACCESS_DAYS,
        retentionDays: parsed.GUEST_DATA_RETENTION_DAYS,
      },
      maxVouchersPerBooking: parsed.BOOKING_VOUCHER_MAX_PER_BOOKING,
      voucherKeyPrefix: parsed.BOOKING_VOUCHER_KEY_PREFIX.replace(/\/+$/, ''),
    },
    attachments: {
      maxPerOffer: parsed.MAX_OFFER_ATTACHMENTS,
      maxPerConversation: parsed.MAX_MESSAGE_ATTACHMENTS_PER_CONVERSATION,
      keyPrefix: parsed.ATTACHMENT_KEY_PREFIX.replace(/\/+$/, ''),
    },
    webhooks: {
      maxEndpointsPerOrganization: parsed.WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION,
      timeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
      maxAttempts: parsed.WEBHOOK_MAX_ATTEMPTS,
      retryBaseMs: parsed.WEBHOOK_RETRY_BASE_SECONDS * 1000,
      retryMaxMs: parsed.WEBHOOK_RETRY_MAX_MINUTES * 60000,
      disableAfterFailures: parsed.WEBHOOK_DISABLE_AFTER_FAILURES,
      secretRotationGraceMs: parsed.WEBHOOK_SECRET_ROTATION_GRACE_HOURS * 3600000,
      deliveryRetentionDays: parsed.WEBHOOK_DELIVERY_RETENTION_DAYS,
      intervalMs: parsed.WEBHOOK_JOB_INTERVAL_SECONDS * 1000,
      allowInsecureUrls: parsed.WEBHOOK_ALLOW_INSECURE_URLS,
    },
    operations: {
      backupDirectory: parsed.BACKUP_DIRECTORY,
      backupKeyPrefix: parsed.BACKUP_KEY_PREFIX.replace(/\/+$/, ''),
      backupMaxAgeHours: parsed.BACKUP_MAX_AGE_HOURS,
      restoreDrillMaxAgeDays: parsed.RESTORE_DRILL_MAX_AGE_DAYS,
      pgBinDirectory: parsed.PG_BIN_DIRECTORY ?? null,
    },
    sessionLifetimeMs: parsed.SESSION_LIFETIME_HOURS * 3600000,
    mfaChallengeTtlMs: parsed.MFA_CHALLENGE_TTL_MINUTES * 60000,
    maxCoverageDestinations: parsed.MAX_COVERAGE_DESTINATIONS,
    destinationSearchLimit: parsed.DESTINATION_SEARCH_LIMIT,
    destinationChildrenLimit: parsed.DESTINATION_CHILDREN_LIMIT,
    retention: {
      accountDeletionGraceDays: parsed.ACCOUNT_DELETION_GRACE_DAYS,
      unverifiedAccountDays: parsed.UNVERIFIED_ACCOUNT_RETENTION_DAYS,
      intervalMs: parsed.RETENTION_JOB_INTERVAL_SECONDS * 1000,
    },
    geonames: {
      dumpUrl: parsed.GEONAMES_DUMP_URL.replace(/\/$/, ''),
      citiesDataset: parsed.GEONAMES_CITIES_DATASET,
      placeFeatureCodes: parsed.GEONAMES_PLACE_FEATURE_CODES,
      aliasLanguages: parsed.GEONAMES_ALIAS_LANGUAGES,
      excludedFeatureCodes: parsed.GEONAMES_EXCLUDED_FEATURE_CODES,
      minPlacePopulation: parsed.GEONAMES_MIN_PLACE_POPULATION,
      maxAliases: parsed.GEONAMES_MAX_ALIASES,
    },
    routing: {
      destinationCountries: parsed.DESTINATION_COUNTRIES,
      hotelLeadAllowedDestinationKinds: parsed.HOTEL_LEAD_ALLOWED_DESTINATION_KINDS,
      maxRequestDestinations: parsed.MAX_REQUEST_DESTINATIONS,
      maxOffersPerHotelOrgPerRequest: parsed.MAX_OFFERS_PER_HOTEL_ORG_PER_REQUEST,
      maxInstantAlertsPerRequest: parsed.MAX_INSTANT_ALERTS_PER_REQUEST,
      digestSendHourUtc: parsed.DIGEST_SEND_HOUR_UTC,
      maxHotelPropertiesPerOrganization: parsed.MAX_HOTEL_PROPERTIES_PER_ORGANIZATION,
      digestIntervalMs: parsed.ALERT_DIGEST_JOB_INTERVAL_SECONDS * 1000,
      featuredImportMaxRows: parsed.FEATURED_IMPORT_MAX_ROWS,
    },
    legal: {
      entityName: parsed.LEGAL_ENTITY_NAME ?? null,
      grievanceOfficer: parsed.GRIEVANCE_OFFICER_NAME && parsed.GRIEVANCE_OFFICER_EMAIL
        ? { name: parsed.GRIEVANCE_OFFICER_NAME, email: parsed.GRIEVANCE_OFFICER_EMAIL, phone: parsed.GRIEVANCE_OFFICER_PHONE ?? null, address: parsed.GRIEVANCE_OFFICER_ADDRESS ?? null }
        : null,
    },
  };
}

export const config = loadConfig();

export function countryList(locale = 'en') {
  return Object.entries(countries.getNames(locale, { select: 'official' }))
    .map(([code, name]) => ({ code, name }))
    .sort((left, right) => left.name.localeCompare(right.name, locale));
}

export function countryName(code, locale = 'en') {
  return countries.getName(code, locale, { select: 'official' }) ?? code;
}

export function currencyList() {
  return [...supportedCurrencies].sort();
}
