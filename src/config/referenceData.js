// Single source of truth for marketplace vocabularies; values must match the DB CHECK constraints.
export const businessTypes = [
  { value: 'agency', label: 'Travel agency' },
  { value: 'dmc', label: 'Destination management company' },
  { value: 'hotelier', label: 'Hotel' },
];

export const groupTypes = [
  { value: 'family', label: 'Family' },
  { value: 'honeymoon', label: 'Honeymoon' },
  { value: 'friends', label: 'Friends' },
  { value: 'corporate', label: 'Corporate / MICE' },
  { value: 'school', label: 'School' },
  { value: 'seniors', label: 'Seniors' },
  { value: 'solo', label: 'Solo' },
  { value: 'other', label: 'Other' },
];

export const mealPlans = [
  { value: 'room_only', label: 'Room only' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'half_board', label: 'Half board' },
  { value: 'full_board', label: 'Full board' },
  { value: 'all_inclusive', label: 'All inclusive' },
];

export const hotelCategories = [3, 4, 5].map((stars) => ({ value: stars, label: `${stars} star` }));

// allowedFor: the requirement types a service may appear in; a hotel-only lead can ask only for hotel services.
export const serviceTypes = [
  { value: 'hotel', label: 'Hotel', allowedFor: ['hotel_only', 'itinerary'] },
  { value: 'transfers', label: 'Transfers', allowedFor: ['itinerary'] },
  { value: 'sightseeing', label: 'Sightseeing', allowedFor: ['itinerary'] },
  { value: 'guide', label: 'Guide', allowedFor: ['itinerary'] },
  { value: 'visa', label: 'Visa', allowedFor: ['itinerary'] },
  { value: 'flights', label: 'Flights', allowedFor: ['itinerary'] },
];

// audience: the only seller business type that may ever see a lead of this type.
export const requirementTypes = [
  { value: 'hotel_only', label: 'Hotel only', audience: 'hotelier', description: 'Only hotel owners in the chosen area see this lead.', maxDestinations: 1 },
  { value: 'itinerary', label: 'Itinerary / package', audience: 'dmc', description: 'Only DMCs covering the chosen area see this lead.', maxDestinations: null },
];

export const coverageModes = [
  { value: 'include', label: 'Covered' },
  { value: 'exclude', label: 'Not covered' },
];

export const matchTypes = [
  { value: 'full', label: 'Full coverage' },
  { value: 'partial', label: 'Partial coverage' },
  { value: 'invited', label: 'Invited' },
];

export const alertDeliveryModes = [
  { value: 'instant', label: 'Instant alert' },
  { value: 'digest', label: 'Daily digest' },
  { value: 'off', label: 'No alerts (feed only)' },
];

export const hotelPropertyStatuses = [
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export const audienceFor = (requirementType) => requirementTypes.find((item) => item.value === requirementType)?.audience ?? null;

// SQL CASE mapping a request's requirement type to its only eligible seller business type.
export const requirementAudienceSql = (column) => `(CASE ${column} ${requirementTypes.map((item) => `WHEN '${item.value}' THEN '${item.audience}'`).join(' ')} END)`;

export const offerInclusions = [
  { value: 'accommodation', label: 'Accommodation' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'meals', label: 'Meals' },
  { value: 'transfers', label: 'Transfers' },
  { value: 'sightseeing', label: 'Sightseeing' },
  { value: 'guide', label: 'Guide' },
  { value: 'taxes', label: 'Taxes' },
  { value: 'visa', label: 'Visa' },
  { value: 'flights', label: 'Flights' },
  { value: 'rail', label: 'Rail' },
  { value: 'insurance', label: 'Insurance' },
];

export const requestVisibilities = [
  { value: 'open', label: 'Open to all matching verified sellers' },
  { value: 'invite_only', label: 'Invited suppliers only' },
  { value: 'open_and_invite', label: 'Matching sellers and invited suppliers' },
];

export const capabilities = {
  teamManage: 'team.manage',
  profileManage: 'profile.manage',
  requestWrite: 'request.write',
  requestAward: 'request.award',
  offerWrite: 'offer.write',
  messageWrite: 'message.write',
  bookingManage: 'booking.manage',
  integrationManage: 'integration.manage',
};

export const memberRoles = [
  { value: 'owner', label: 'Owner', capabilities: Object.values(capabilities) },
  { value: 'admin', label: 'Manager', capabilities: Object.values(capabilities) },
  { value: 'member', label: 'Staff', capabilities: [capabilities.requestWrite, capabilities.offerWrite, capabilities.messageWrite, capabilities.bookingManage] },
  { value: 'viewer', label: 'View only', capabilities: [] },
];

export const valuesOf = (list) => new Set(list.map((item) => item.value));

export const offerLineItemTypes = [
  { value: 'accommodation', label: 'Accommodation' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'sightseeing', label: 'Sightseeing' },
  { value: 'guide', label: 'Guide' },
  { value: 'meal', label: 'Meal' },
  { value: 'visa', label: 'Visa' },
  { value: 'flight', label: 'Flight' },
  { value: 'rail', label: 'Rail' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'tax', label: 'Tax / fee' },
  { value: 'other', label: 'Other' },
];

export const negotiationKinds = [
  { value: 'revision_request', label: 'Revision request' },
  { value: 'counter_offer', label: 'Counter-offer' },
];

export const negotiationStatuses = [
  { value: 'open', label: 'Waiting for the seller' },
  { value: 'accepted', label: 'Counter-offer accepted' },
  { value: 'revised', label: 'Seller revised the offer' },
  { value: 'declined', label: 'Seller declined' },
  { value: 'withdrawn', label: 'Withdrawn by the agency' },
  { value: 'closed', label: 'Closed when the request was decided' },
];

export const reportTargetTypes = [
  { value: 'request', label: 'Request' },
  { value: 'offer', label: 'Offer' },
  { value: 'message', label: 'Message' },
  { value: 'organization', label: 'Organization' },
];

export const reportCategories = [
  { value: 'spam', label: 'Spam or irrelevant' },
  { value: 'contact_bypass', label: 'Trying to move the deal off-platform' },
  { value: 'fake_business', label: 'Fake or misrepresented business' },
  { value: 'pricing_fraud', label: 'Misleading price or terms' },
  { value: 'abusive', label: 'Abusive or offensive behaviour' },
  { value: 'other', label: 'Other' },
];

// Generic labels; per-country wording (e.g. the local name of level 1) lives in country_destination_levels.
export const destinationKinds = [
  { value: 'country', label: 'Country', depth: 0 },
  { value: 'region', label: 'Region', depth: 1 },
  { value: 'district', label: 'District', depth: 2 },
  { value: 'city', label: 'Place', depth: 3 },
];

// Which kinds may parent each kind.
export const destinationParentKinds = {
  country: [],
  region: ['country'],
  district: ['region'],
  city: ['district', 'region', 'country'],
};

// acceptance: who must accept each published version (all_members, organization_owner) or notice-only.
export const legalDocumentTypes = [
  { value: 'terms', label: 'Terms of use', acceptance: 'all_members' },
  { value: 'privacy', label: 'Privacy policy', acceptance: 'all_members' },
  { value: 'dpa', label: 'Data processing agreement', acceptance: 'organization_owner' },
  { value: 'cookies', label: 'Cookie policy', acceptance: 'notice' },
];

export const verificationDocumentTypes = [
  { value: 'gst_certificate', label: 'GST registration certificate' },
  { value: 'pan_card', label: 'Business PAN card' },
  { value: 'business_registration', label: 'Business registration certificate (Company, LLP or Udyam in India)' },
  { value: 'tax_registration', label: 'Tax registration certificate' },
  { value: 'property_proof', label: 'Proof of property ownership or management' },
  { value: 'tourism_recognition', label: 'Tourism recognition (IATA, TAAI or Ministry of Tourism)' },
];

// countryCode null applies to every country without its own row.
export const verificationDocumentRequirements = [
  { countryCode: 'IN', businessType: 'agency', required: ['gst_certificate', 'pan_card', 'business_registration'], optional: ['tourism_recognition'] },
  { countryCode: null, businessType: 'agency', required: ['business_registration', 'tax_registration'], optional: ['tourism_recognition'] },
  { countryCode: 'IN', businessType: 'dmc', required: ['gst_certificate', 'pan_card', 'business_registration'], optional: ['tourism_recognition'] },
  { countryCode: 'IN', businessType: 'hotelier', required: ['gst_certificate', 'pan_card', 'property_proof'], optional: ['business_registration', 'tourism_recognition'] },
  { countryCode: null, businessType: 'dmc', required: ['business_registration', 'tax_registration'], optional: ['tourism_recognition'] },
  { countryCode: null, businessType: 'hotelier', required: ['business_registration', 'property_proof'], optional: ['tax_registration'] },
];

export const agencyVerificationStatuses = [
  { value: 'unsubmitted', label: 'Not submitted' },
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
];

export const bookingStatuses = [
  { value: 'awarded', label: 'Awarded, booking not confirmed' },
  { value: 'confirmation_pending', label: 'Booking confirmed, waiting for seller confirmation' },
  { value: 'booked', label: 'Booked' },
  { value: 'cancelled', label: 'Cancelled' },
];

export const bookingChangeTypes = [
  { value: 'amendment', label: 'Booking change' },
  { value: 'cancellation', label: 'Cancellation request' },
];

export const bookingChangeStatuses = [
  { value: 'pending', label: 'Waiting for the other party' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

export const comparisonLabels = [
  { value: 'lowest', label: 'Lowest total' },
  { value: 'most_inclusive', label: 'Most inclusive' },
];

// Age bounds (in years) a guest of each type must have on the trip; adults have no age.
export const travellerTypes = [
  { value: 'adult', label: 'Adult', minAge: null, maxAge: null },
  { value: 'child', label: 'Child', minAge: 2, maxAge: 17 },
  { value: 'infant', label: 'Infant', minAge: 0, maxAge: 1 },
];

export const guestAccessActions = [
  { value: 'released', label: 'Released to seller' },
  { value: 'viewed', label: 'Viewed' },
  { value: 'corrected', label: 'Corrected' },
  { value: 'revoked', label: 'Seller access revoked' },
  { value: 'restored', label: 'Seller access restored' },
  { value: 'purged', label: 'Deleted under retention' },
  { value: 'voucher_opened', label: 'Voucher opened' },
];

// Notification event types an organization may receive as signed webhooks; businessTypes limits who can subscribe.
// Account, security and document events are deliberately absent.
const agency = ['agency'];
const sellers = ['dmc', 'hotelier'];
const everyone = ['agency', 'dmc', 'hotelier'];
export const webhookEventTypes = [
  { value: 'request_matched', label: 'New matching request', businessTypes: sellers },
  { value: 'request_matched_digest', label: 'Daily digest of matching requests', businessTypes: sellers },
  { value: 'request_no_longer_available', label: 'Request no longer in your area', businessTypes: sellers },
  { value: 'request_deadline_near', label: 'Request deadline is near', businessTypes: everyone },
  { value: 'request_closed', label: 'Request closed for new offers', businessTypes: everyone },
  { value: 'request_expired', label: 'Request expired without offers', businessTypes: agency },
  { value: 'request_cancelled', label: 'Request cancelled', businessTypes: sellers },
  { value: 'request_trip_changed', label: 'Trip details changed', businessTypes: sellers },
  { value: 'request_message', label: 'New request message', businessTypes: everyone },
  { value: 'offer_submitted', label: 'New offer received', businessTypes: agency },
  { value: 'offer_revised', label: 'Offer revised', businessTypes: agency },
  { value: 'offer_withdrawn', label: 'Offer withdrawn', businessTypes: agency },
  { value: 'offer_reconfirmed', label: 'Offer re-confirmed for changed trip', businessTypes: agency },
  { value: 'offer_revision_requested', label: 'Agency asked for a revised offer', businessTypes: sellers },
  { value: 'offer_counter_received', label: 'Agency sent a counter-offer', businessTypes: sellers },
  { value: 'offer_counter_accepted', label: 'Seller accepted a counter-offer', businessTypes: agency },
  { value: 'offer_negotiation_declined', label: 'Seller declined a revision or counter-offer', businessTypes: agency },
  { value: 'offer_expiring', label: 'Offer expiring soon', businessTypes: everyone },
  { value: 'offer_awarded', label: 'Offer awarded', businessTypes: sellers },
  { value: 'offer_not_selected', label: 'Offer not selected', businessTypes: sellers },
  { value: 'award_undone', label: 'Agency undid an award decision', businessTypes: sellers },
  { value: 'seller_profile_changed', label: 'Seller profile changed, offer withdrawn', businessTypes: agency },
  { value: 'booking_confirmed', label: 'Booking confirmed by the agency', businessTypes: sellers },
  { value: 'booking_seller_confirmed', label: 'Seller confirmed the booking', businessTypes: agency },
  { value: 'booking_voucher_ready', label: 'Booking voucher ready', businessTypes: agency },
  { value: 'booking_change_requested', label: 'Booking change requested', businessTypes: everyone },
  { value: 'booking_change_accepted', label: 'Booking change accepted', businessTypes: everyone },
  { value: 'booking_change_declined', label: 'Booking change declined', businessTypes: everyone },
  { value: 'booking_cancellation_requested', label: 'Booking cancellation requested', businessTypes: everyone },
  { value: 'booking_cancelled', label: 'Booking cancelled', businessTypes: everyone },
  { value: 'guest_details_corrected', label: 'Guest details corrected', businessTypes: sellers },
  { value: 'guest_details_revoked', label: 'Guest details access revoked', businessTypes: sellers },
  { value: 'guest_details_restored', label: 'Guest details access restored', businessTypes: sellers },
  { value: 'report_resolved', label: 'Report reviewed', businessTypes: everyone },
];

export const webhookTestEventType = 'webhook_test';

export const webhookDeliveryStatuses = [
  { value: 'pending', label: 'Waiting to send' },
  { value: 'processing', label: 'Sending' },
  { value: 'retrying', label: 'Failed, will retry' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'dead_letter', label: 'Failed, retries exhausted' },
  { value: 'cancelled', label: 'Cancelled (endpoint disabled)' },
];

// monitored kinds get an overdue check on the operations dashboard.
export const operationRunKinds = [
  { value: 'database_backup', label: 'Database backup', monitored: true },
  { value: 'restore_drill', label: 'Restore drill', monitored: true },
  { value: 'destination_import', label: 'Destination import', monitored: false },
  { value: 'featured_import', label: 'Featured destinations import', monitored: false },
  { value: 'routing_launch', label: 'Lead routing launch', monitored: false },
];

export const documentScanStatuses = [
  { value: 'pending', label: 'Awaiting malware scan' },
  { value: 'clean', label: 'Scanned, no threats found' },
  { value: 'infected', label: 'Blocked: malware detected' },
  { value: 'failed', label: 'Scan failed, upload again' },
];
