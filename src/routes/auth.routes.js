import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config, isCountryCode } from '../config/index.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { businessTypes, capabilities, coverageModes } from '../config/referenceData.js';
import { capabilitiesFor, requireCapability } from '../services/permissions.js';
import { recordOrganizationEvent } from '../services/organizationAudit.js';
import { parseWith } from '../utils/validation.js';
import { encryptEmailActionToken, hashEmailActionToken } from '../utils/emailActionTokens.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { createRecoveryCodes, createTotpEnrollment, decryptTotpSecret, hashRecoveryCode, hashTotpCode, normalizeRecoveryCode, verifyTotpCode } from '../services/totp.js';
import { loadCoverage, normalizeCoverageRules, replaceCoverage, resolveActiveDestinations, sellerProfileResponse } from '../services/destinations.js';
import { propertyDestinationKinds } from '../services/hotelProperties.js';
import { routingDeclinePrefix } from '../services/routing.js';
import { legalDocumentDto, missingAcceptances, pendingLegalDocuments, recordAcceptances } from '../services/legal.js';

const allowedBusinessTypes = new Set(businessTypes.map((type) => type.value));
const sessionLifetimeMs = config.sessionLifetimeMs;
const mfaChallengeTtlMs = config.mfaChallengeTtlMs;
const passwordWorkFactor = 12;
const emailVerificationLifetimeMs = 24 * 60 * 60 * 1000;
const passwordResetLifetimeMs = 15 * 60 * 1000;

function apiError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createSessionCookie(response, token, cookieName, secureCookies) {
  response.cookie(cookieName, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionLifetimeMs,
  });
}

function createMfaChallengeCookie(response, token, cookieName, secureCookies) {
  response.cookie(`${cookieName}_mfa_challenge`, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: mfaChallengeTtlMs,
  });
}

function clearMfaChallengeCookie(response, cookieName, secureCookies) {
  response.clearCookie(`${cookieName}_mfa_challenge`, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' });
}

async function createMfaChallenge(client, response, userId, organizationId, cookieName, secureCookies) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO mfa_login_challenges (id, user_id, organization_id, token_hash, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, organizationId, hashToken(token), csrfToken, new Date(Date.now() + mfaChallengeTtlMs)],
  );
  createMfaChallengeCookie(response, token, cookieName, secureCookies);
  return csrfToken;
}

async function saveSession(client, userId, organizationId) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);

  await client.query(
    `INSERT INTO auth_sessions (id, user_id, organization_id, token_hash, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, organizationId, hashToken(token), csrfToken, expiresAt],
  );

  return { token, csrfToken };
}

async function queueEmailAction(client, { userId, organizationId, purpose, tokenEncryptionKey }) {
  const token = randomBytes(32).toString('base64url');
  const tokenId = randomUUID();
  const eventType = purpose === 'verify_email' ? 'email_verification' : 'password_recovery';
  const title = purpose === 'verify_email' ? 'Verify your Lead Exchange email' : 'Reset your Lead Exchange password';
  const message = purpose === 'verify_email'
    ? 'Use the secure link to verify your business email address.'
    : 'Use the secure link to set a new password. If you did not request this, ignore this email.';
  const expiresAt = new Date(Date.now() + (purpose === 'verify_email' ? emailVerificationLifetimeMs : passwordResetLifetimeMs));

  await client.query(
    `UPDATE auth_email_tokens SET used_at = NOW(), token_ciphertext = NULL
     WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  await client.query(
    `INSERT INTO auth_email_tokens (id, user_id, purpose, token_hash, token_ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tokenId, userId, purpose, hashEmailActionToken(token), encryptEmailActionToken(token, tokenEncryptionKey), expiresAt],
  );
  await client.query(
    `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), organizationId, eventType, title, message, JSON.stringify({ authEmailTokenId: tokenId, recipientUserId: userId })],
  );
}

async function consumeMfaCode(client, userId, code, mfa, mfaEncryptionKey) {
  if (/^\d{6}$/.test(code)) {
    const secret = decryptTotpSecret(mfa.secret_ciphertext, mfaEncryptionKey);
    if (!(await verifyTotpCode(secret, code))) return false;
    const codeHash = hashTotpCode(code);
    const lastAcceptedAt = mfa.last_totp_accepted_at ? new Date(mfa.last_totp_accepted_at).getTime() : 0;
    if (safeEqual(mfa.last_totp_code_hash, codeHash) && Date.now() - lastAcceptedAt < 90000) return false;
    await client.query(
      'UPDATE user_mfa SET last_totp_code_hash = $2, last_totp_accepted_at = NOW(), updated_at = NOW() WHERE user_id = $1',
      [userId, codeHash],
    );
    return true;
  }

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 32) return false;
  const recoveryCode = await client.query(
    'SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL FOR UPDATE',
    [userId, hashRecoveryCode(normalized)],
  );
  if (!recoveryCode.rowCount) return false;
  await client.query('UPDATE mfa_recovery_codes SET used_at = NOW() WHERE id = $1', [recoveryCode.rows[0].id]);
  return true;
}

export async function loadSession(pool, request, response, next) {
  const token = request.cookies?.[request.app.locals.sessionCookieName];
  if (!token || !pool) return apiError(response, pool ? 401 : 503, pool ? 'UNAUTHENTICATED' : 'DATABASE_NOT_CONFIGURED', pool ? 'Sign in to continue.' : 'Account service is unavailable until the database is configured.');

  try {
    const result = await pool.query(
            `SELECT s.id AS session_id, s.token_hash, s.csrf_token, u.id AS user_id, u.is_platform_admin, u.email_verified_at,
              u.full_name, u.email, u.deletion_requested_at, u.deletion_scheduled_for, o.id AS organization_id, o.name AS organization_name,
              o.business_type, o.country_code, o.suspended_at, o.closure_scheduled_for, o.verified_at, m.access_role, COALESCE(mfa.enabled, FALSE) AS mfa_enabled
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organization_memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
       JOIN organizations o ON o.id = m.organization_id
      LEFT JOIN user_mfa mfa ON mfa.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [hashToken(token)],
    );
    if (!result.rowCount) return apiError(response, 401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    if (!result.rows[0].email_verified_at) {
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [result.rows[0].token_hash]);
      return apiError(response, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.');
    }
    if (result.rows[0].suspended_at) {
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [result.rows[0].token_hash]);
      return apiError(response, 403, 'ORGANIZATION_SUSPENDED', 'This organization is suspended. Contact platform support.');
    }
    request.auth = result.rows[0];
    request.sessionTokenHash = result.rows[0].token_hash;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireMfaForPlatformAdmin(request, response, next) {
  if (request.auth.is_platform_admin && !request.auth.mfa_enabled) {
    return apiError(response, 403, 'MFA_REQUIRED', 'Enable multi-factor authentication before using platform-admin tools.');
  }
  return next();
}

export function requireCsrf(request, response, next) {
  if (!safeEqual(request.get('x-csrf-token'), request.auth.csrf_token)) {
    return apiError(response, 403, 'CSRF_INVALID', 'Refresh your session and try again.');
  }
  return next();
}

// Blocks marketplace use while account deletion is pending or current legal terms are not accepted.
export async function requireActiveAccount(pool, request, response, next) {
  if (request.auth.deletion_requested_at) return apiError(response, 403, 'ACCOUNT_DELETION_PENDING', 'This account is scheduled for deletion. Cancel the deletion to continue.');
  try {
    const pending = await pendingLegalDocuments(pool, request.auth.user_id, request.auth.access_role);
    if (pending.length) return apiError(response, 403, 'LEGAL_ACCEPTANCE_REQUIRED', `Review and accept: ${pending.map((row) => row.title).join(', ')}.`);
    return next();
  } catch (error) {
    return next(error);
  }
}

const destinationIdSchema = z.uuid('Choose a destination from the destination list.');
const registrationExtrasSchema = z.object({
  coverage_destination_ids: z.array(destinationIdSchema).max(config.maxCoverageDestinations, `Choose up to ${config.maxCoverageDestinations} destinations.`).default([]).transform((ids) => [...new Set(ids)]),
  property_destination_id: destinationIdSchema.nullish(),
  accepted_legal_document_ids: z.array(z.uuid()).max(20).default([]),
});

function validRegistration(body) {
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const organizationName = typeof body.organization_name === 'string' ? body.organization_name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const countryCode = typeof body.country_code === 'string' ? body.country_code.trim().toUpperCase() : '';
  const businessType = typeof body.business_type === 'string' ? body.business_type : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (fullName.length < 2 || fullName.length > 120) return { error: 'Enter a name between 2 and 120 characters.' };
  if (organizationName.length < 2 || organizationName.length > 160) return { error: 'Enter a business name between 2 and 160 characters.' };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid business email address.' };
  if (!isCountryCode(countryCode)) return { error: 'Choose a valid country or region.' };
  if (!allowedBusinessTypes.has(businessType)) return { error: 'Choose a supported business type.' };
  const extras = parseWith(registrationExtrasSchema, body);
  if (extras.error) return { error: extras.error };
  const { coverage_destination_ids: coverageDestinationIds, property_destination_id: propertyDestinationId, accepted_legal_document_ids: acceptedLegalDocumentIds } = extras.data;
  if (businessType === 'dmc' && coverageDestinationIds.length === 0) return { error: `Add between 1 and ${config.maxCoverageDestinations} destinations your DMC serves.` };
  if (businessType === 'hotelier' && !propertyDestinationId) return { error: 'Choose the city where your property is located.' };
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return { error: 'Password must be at least 8 characters and no more than 72 bytes.' };

  return {
    fullName, organizationName, email, countryCode, businessType, password, acceptedLegalDocumentIds,
    coverageDestinationIds: businessType === 'dmc' ? coverageDestinationIds : [],
    propertyDestinationId: businessType === 'hotelier' ? propertyDestinationId : null,
  };
}

export function createAuthRouter({ pool, secureCookies, cookieName, emailDelivery = null, tokenEncryptionKey = null, mfaEncryptionKey = null, emailVerificationRequired = config.emailVerificationRequired }) {
  const router = Router();
  const authLimiter = createRateLimiter(config.rateLimits.auth, 'Too many attempts. Try again later.');
  const loginLimiter = createRateLimiter(config.rateLimits.auth, 'Too many failed sign-in attempts. Try again later.', { skipSuccessfulRequests: true });
  const emailActionLimiter = createRateLimiter(config.rateLimits.emailAction, 'Too many email security requests. Try again later.');
  const mfaLimiter = createRateLimiter(config.rateLimits.mfa, 'Too many MFA attempts. Try again later.');

  router.post('/register', authLimiter, async (request, response, next) => {
    const input = validRegistration(request.body ?? {});
    if (input.error) return apiError(response, 400, 'VALIDATION_ERROR', input.error);
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable until the database is configured.');
    if (emailVerificationRequired && !tokenEncryptionKey) return apiError(response, 503, 'EMAIL_SECURITY_NOT_CONFIGURED', 'Email verification cannot be started until the email-token encryption key is configured.');

    const client = await pool.connect();
    try {
      const missing = await missingAcceptances(client, input.acceptedLegalDocumentIds, 'owner');
      if (missing.length) return apiError(response, 400, 'LEGAL_ACCEPTANCE_REQUIRED', `Accept the current ${missing.map((row) => row.title).join(', ')} to create an account.`);
      const coverage = await resolveActiveDestinations(client, input.coverageDestinationIds);
      if (coverage.error) return apiError(response, 400, 'VALIDATION_ERROR', coverage.error);
      const property = await resolveActiveDestinations(client, input.propertyDestinationId ? [input.propertyDestinationId] : [], { kinds: propertyDestinationKinds });
      if (property.error) return apiError(response, 400, 'VALIDATION_ERROR', property.error);
      const passwordHash = await bcrypt.hash(input.password, passwordWorkFactor);
      const organizationId = randomUUID();
      const userId = randomUUID();
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organizations (id, name, business_type, country_code) VALUES ($1, $2, $3, $4)',
        [organizationId, input.organizationName, input.businessType, input.countryCode],
      );
      await client.query(
        'INSERT INTO users (id, full_name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NULL ELSE NOW() END)',
        [userId, input.fullName, input.email, passwordHash, emailVerificationRequired],
      );
      await client.query(
        "INSERT INTO organization_memberships (id, organization_id, user_id, access_role) VALUES ($1, $2, $3, 'owner')",
        [randomUUID(), organizationId, userId],
      );
      if (input.businessType !== 'agency') {
        await client.query(
          'INSERT INTO seller_profiles (organization_id, property_destination_id) VALUES ($1, $2)',
          [organizationId, input.propertyDestinationId],
        );
        await replaceCoverage(client, organizationId, input.coverageDestinationIds);
        if (input.propertyDestinationId) {
          await client.query(
            'INSERT INTO hotel_properties (id, organization_id, name, destination_id) VALUES ($1, $2, $3, $4)',
            [randomUUID(), organizationId, input.organizationName, input.propertyDestinationId],
          );
        }
      }
      await recordAcceptances(client, { userId, organizationId, documentIds: input.acceptedLegalDocumentIds });
      if (emailVerificationRequired) await queueEmailAction(client, { userId, organizationId, purpose: 'verify_email', tokenEncryptionKey });
      await client.query('COMMIT');
      return response.status(201).json({
        user: { id: userId, fullName: input.fullName, email: input.email, isPlatformAdmin: false },
        organization: { id: organizationId, name: input.organizationName, businessType: input.businessType, countryCode: input.countryCode },
        verificationRequired: emailVerificationRequired,
        emailDeliveryStatus: emailVerificationRequired ? (emailDelivery ? 'queued' : 'blocked_config') : 'not_required',
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return apiError(response, 409, 'EMAIL_IN_USE', 'An account already uses this email. Sign in or use another email.');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/login', loginLimiter, async (request, response, next) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const businessType = typeof request.body?.business_type === 'string' ? request.body.business_type : '';
    if (!email || !password || !allowedBusinessTypes.has(businessType)) return apiError(response, 400, 'VALIDATION_ERROR', 'Enter your email, password and business type.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable until the database is configured.');

    const client = await pool.connect();
    try {
      const account = await client.query(
        `SELECT u.id AS user_id, u.full_name, u.email, u.password_hash, u.is_platform_admin, u.email_verified_at,
          COALESCE(mfa.enabled, FALSE) AS mfa_enabled,
                o.id AS organization_id, o.name AS organization_name,
                o.business_type, o.country_code, o.suspended_at
         FROM users u
         JOIN organization_memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN user_mfa mfa ON mfa.user_id = u.id
         WHERE u.email = $1 AND o.business_type = $2
         ORDER BY (o.suspended_at IS NOT NULL), o.created_at, o.id
         LIMIT 1`,
        [email, businessType],
      );
      const user = account.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return apiError(response, 401, 'INVALID_CREDENTIALS', 'Email, password or business type is incorrect.');
      }
      if (!user.email_verified_at) return apiError(response, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.');
      if (user.suspended_at) return apiError(response, 403, 'ORGANIZATION_SUSPENDED', 'This organization is suspended. Contact platform support.');

      if (user.mfa_enabled) {
        if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA verification is unavailable until its encryption key is configured.');
        const csrfToken = await createMfaChallenge(client, response, user.user_id, user.organization_id, cookieName, secureCookies);
        return response.status(200).json({ mfaRequired: true, csrfToken });
      }

      const session = await saveSession(client, user.user_id, user.organization_id);
      createSessionCookie(response, session.token, cookieName, secureCookies);
      return response.status(200).json({
        user: { id: user.user_id, fullName: user.full_name, email: user.email, isPlatformAdmin: user.is_platform_admin, mfaEnabled: false },
        organization: { id: user.organization_id, name: user.organization_name, businessType: user.business_type, countryCode: user.country_code },
        csrfToken: session.csrfToken,
        mfaSetupRequired: Boolean(user.is_platform_admin),
      });
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/mfa/status', (request, response, next) => loadSession(pool, request, response, next), async (request, response, next) => {
    try {
      const recovery = await pool.query('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [request.auth.user_id]);
      return response.json({ enabled: request.auth.mfa_enabled, recoveryCodesRemaining: Number(recovery.rows[0].count) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/mfa/enrollment/start', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, mfaLimiter, async (request, response, next) => {
    if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA enrollment is unavailable until its encryption key is configured.');
    const enrollment = createTotpEnrollment(request.auth.email, mfaEncryptionKey);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    try {
      const result = await pool.query(
        `INSERT INTO user_mfa (user_id, secret_ciphertext, enabled, pending_expires_at)
         VALUES ($1, $2, FALSE, $3)
         ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext,
           pending_expires_at = EXCLUDED.pending_expires_at, updated_at = NOW()
         WHERE user_mfa.enabled = FALSE RETURNING user_id`,
        [request.auth.user_id, enrollment.secretCiphertext, expiresAt],
      );
      if (!result.rowCount) return fail(response, 409, 'MFA_ALREADY_ENABLED', 'Multi-factor authentication is already enabled for this account.');
      return response.status(201).json({ secret: enrollment.secret, otpauthUri: enrollment.uri, expiresAt });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/mfa/enrollment/confirm', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, mfaLimiter, async (request, response, next) => {
    if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA enrollment is unavailable until its encryption key is configured.');
    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return apiError(response, 400, 'MFA_CODE_INVALID', 'Enter the six-digit code from your authenticator app.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pending = await client.query(
        `SELECT secret_ciphertext FROM user_mfa
         WHERE user_id = $1 AND enabled = FALSE AND pending_expires_at > NOW() FOR UPDATE`,
        [request.auth.user_id],
      );
      if (!pending.rowCount) {
        await client.query('ROLLBACK');
        return fail(response, 404, 'MFA_ENROLLMENT_EXPIRED', 'Start MFA enrollment again to receive a new setup secret.');
      }
      const secret = decryptTotpSecret(pending.rows[0].secret_ciphertext, mfaEncryptionKey);
      if (!(await verifyTotpCode(secret, code))) {
        await client.query('ROLLBACK');
        return fail(response, 400, 'MFA_CODE_INVALID', 'The authenticator code did not match. Try the current code again.');
      }
      const recoveryCodes = createRecoveryCodes();
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [request.auth.user_id]);
      for (const recoveryCode of recoveryCodes) {
        await client.query(
          'INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
          [randomUUID(), request.auth.user_id, hashRecoveryCode(recoveryCode)],
        );
      }
      await client.query(
        `UPDATE user_mfa SET enabled = TRUE, pending_expires_at = NULL,
           last_totp_code_hash = $2, last_totp_accepted_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
        [request.auth.user_id, hashTotpCode(code)],
      );
      await client.query('COMMIT');
      return response.json({ enabled: true, recoveryCodes });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/mfa/challenge/csrf', async (request, response, next) => {
    const token = request.cookies?.[`${cookieName}_mfa_challenge`];
    if (!token || !pool) return apiError(response, 401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again to restart MFA verification.');
    try {
      const challenge = await pool.query(
        `SELECT csrf_token FROM mfa_login_challenges
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5`,
        [hashToken(token)],
      );
      if (!challenge.rowCount) return apiError(response, 401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again to restart MFA verification.');
      return response.json({ csrfToken: challenge.rows[0].csrf_token });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/mfa/challenge', mfaLimiter, async (request, response, next) => {
    const token = request.cookies?.[`${cookieName}_mfa_challenge`];
    if (!token || !pool) return apiError(response, 401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again to restart MFA verification.');
    if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA verification is unavailable until its encryption key is configured.');
    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        `SELECT id, user_id, organization_id, csrf_token, attempts FROM mfa_login_challenges
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5 FOR UPDATE`,
        [hashToken(token)],
      );
      if (!challenge.rowCount) {
        await client.query('ROLLBACK');
        clearMfaChallengeCookie(response, cookieName, secureCookies);
        return apiError(response, 401, 'MFA_CHALLENGE_EXPIRED', 'Sign in again to restart MFA verification.');
      }
      if (!safeEqual(request.get('x-csrf-token'), challenge.rows[0].csrf_token)) {
        await client.query('ROLLBACK');
        return apiError(response, 403, 'CSRF_INVALID', 'Refresh your sign-in and try again.');
      }
      const challengeRow = challenge.rows[0];
      const mfa = await client.query('SELECT secret_ciphertext, last_totp_code_hash, last_totp_accepted_at FROM user_mfa WHERE user_id = $1 AND enabled = TRUE FOR UPDATE', [challengeRow.user_id]);
      const valid = mfa.rowCount ? await consumeMfaCode(client, challengeRow.user_id, code, mfa.rows[0], mfaEncryptionKey) : false;
      if (!valid) {
        const attempts = Number(challengeRow.attempts) + 1;
        await client.query('UPDATE mfa_login_challenges SET attempts = $2::SMALLINT, used_at = CASE WHEN $2::SMALLINT >= 5 THEN NOW() ELSE used_at END WHERE id = $1', [challengeRow.id, attempts]);
        await client.query('COMMIT');
        if (attempts >= 5) clearMfaChallengeCookie(response, cookieName, secureCookies);
        return apiError(response, 401, 'MFA_CODE_INVALID', attempts >= 5 ? 'Too many invalid codes. Sign in again.' : 'The MFA code is invalid or already used.');
      }
      await client.query('UPDATE mfa_login_challenges SET used_at = NOW() WHERE id = $1', [challengeRow.id]);
      const session = await saveSession(client, challengeRow.user_id, challengeRow.organization_id);
      const account = await client.query(
        `SELECT u.full_name, u.email, u.is_platform_admin, organization.id AS organization_id,
                organization.name AS organization_name, organization.business_type, organization.country_code
         FROM users u JOIN organizations organization ON organization.id = $2 WHERE u.id = $1`,
        [challengeRow.user_id, challengeRow.organization_id],
      );
      await client.query('COMMIT');
      createSessionCookie(response, session.token, cookieName, secureCookies);
      clearMfaChallengeCookie(response, cookieName, secureCookies);
      const user = account.rows[0];
      return response.json({
        user: { id: challengeRow.user_id, fullName: user.full_name, email: user.email, isPlatformAdmin: user.is_platform_admin, mfaEnabled: true },
        organization: { id: user.organization_id, name: user.organization_name, businessType: user.business_type, countryCode: user.country_code },
        csrfToken: session.csrfToken,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/mfa/recovery-codes/rotate', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, mfaLimiter, async (request, response, next) => {
    if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA recovery is unavailable until its encryption key is configured.');
    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mfa = await client.query('SELECT secret_ciphertext, last_totp_code_hash, last_totp_accepted_at FROM user_mfa WHERE user_id = $1 AND enabled = TRUE FOR UPDATE', [request.auth.user_id]);
      if (!mfa.rowCount || !(await consumeMfaCode(client, request.auth.user_id, code, mfa.rows[0], mfaEncryptionKey))) {
        await client.query('ROLLBACK');
        return apiError(response, 401, 'MFA_CODE_INVALID', 'Enter a current TOTP or unused recovery code to rotate recovery codes.');
      }
      const recoveryCodes = createRecoveryCodes();
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [request.auth.user_id]);
      for (const recoveryCode of recoveryCodes) {
        await client.query(
          'INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
          [randomUUID(), request.auth.user_id, hashRecoveryCode(recoveryCode)],
        );
      }
      await client.query('COMMIT');
      return response.json({ recoveryCodes });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/mfa/disable', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, mfaLimiter, async (request, response, next) => {
    if (request.auth.is_platform_admin) return apiError(response, 403, 'ADMIN_MFA_REQUIRED', 'Platform administrator MFA cannot be disabled.');
    if (!mfaEncryptionKey) return apiError(response, 503, 'MFA_NOT_CONFIGURED', 'MFA verification is unavailable until its encryption key is configured.');
    const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mfa = await client.query('SELECT secret_ciphertext, last_totp_code_hash, last_totp_accepted_at FROM user_mfa WHERE user_id = $1 AND enabled = TRUE FOR UPDATE', [request.auth.user_id]);
      if (!mfa.rowCount || !(await consumeMfaCode(client, request.auth.user_id, code, mfa.rows[0], mfaEncryptionKey))) {
        await client.query('ROLLBACK');
        return apiError(response, 401, 'MFA_CODE_INVALID', 'Enter a current TOTP or unused recovery code to disable MFA.');
      }
      await client.query('DELETE FROM user_mfa WHERE user_id = $1', [request.auth.user_id]);
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [request.auth.user_id, request.sessionTokenHash]);
      await client.query('COMMIT');
      return response.json({ enabled: false, otherSessionsRevoked: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/verify-email/request', emailActionLimiter, async (request, response, next) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return apiError(response, 400, 'VALIDATION_ERROR', 'Enter a valid email address.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable.');
    if (!tokenEncryptionKey) return apiError(response, 503, 'EMAIL_SECURITY_NOT_CONFIGURED', 'Email verification is not configured.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        `SELECT u.id AS user_id, membership.organization_id, u.email_verified_at
         FROM users u JOIN organization_memberships membership ON membership.user_id = u.id
         WHERE u.email = $1 ORDER BY membership.created_at LIMIT 1`,
        [email],
      );
      if (account.rowCount) {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.rows[0].user_id]);
        if (!account.rows[0].email_verified_at) await queueEmailAction(client, { userId: account.rows[0].user_id, organizationId: account.rows[0].organization_id, purpose: 'verify_email', tokenEncryptionKey });
      }
      await client.query('COMMIT');
      return response.status(202).json({ message: 'If an unverified account exists, verification instructions will be sent when email delivery is available.' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/verify-email/confirm', emailActionLimiter, async (request, response, next) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : '';
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return apiError(response, 400, 'EMAIL_TOKEN_INVALID', 'This email verification link is invalid or expired.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const action = await client.query(
        `SELECT id, user_id FROM auth_email_tokens
         WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [hashEmailActionToken(token)],
      );
      if (!action.rowCount) {
        await client.query('ROLLBACK');
        return apiError(response, 400, 'EMAIL_TOKEN_INVALID', 'This email verification link is invalid or expired.');
      }
      const userId = action.rows[0].user_id;
      await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1', [userId]);
      await client.query(
        `UPDATE auth_email_tokens SET used_at = NOW(), token_ciphertext = NULL
         WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL`,
        [userId],
      );
      await client.query('COMMIT');
      return response.json({ verified: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/password-reset/request', emailActionLimiter, async (request, response, next) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return apiError(response, 400, 'VALIDATION_ERROR', 'Enter a valid email address.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable.');
    if (!tokenEncryptionKey) return apiError(response, 503, 'EMAIL_SECURITY_NOT_CONFIGURED', 'Password recovery is not configured.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        `SELECT u.id AS user_id, membership.organization_id FROM users u
         JOIN organization_memberships membership ON membership.user_id = u.id
         WHERE u.email = $1 AND u.email_verified_at IS NOT NULL
         ORDER BY membership.created_at LIMIT 1`,
        [email],
      );
      if (account.rowCount) {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.rows[0].user_id]);
        await queueEmailAction(client, { userId: account.rows[0].user_id, organizationId: account.rows[0].organization_id, purpose: 'password_reset', tokenEncryptionKey });
      }
      await client.query('COMMIT');
      return response.status(202).json({ message: 'If a verified account exists, password reset instructions will be sent when email delivery is available.' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/password-reset/complete', emailActionLimiter, async (request, response, next) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return apiError(response, 400, 'RESET_TOKEN_INVALID', 'This password reset link is invalid or expired.');
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return apiError(response, 400, 'VALIDATION_ERROR', 'Password must be at least 8 characters and no more than 72 bytes.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable.');
    const passwordHash = await bcrypt.hash(password, passwordWorkFactor);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const action = await client.query(
        `SELECT id, user_id FROM auth_email_tokens
         WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [hashEmailActionToken(token)],
      );
      if (!action.rowCount) {
        await client.query('ROLLBACK');
        return apiError(response, 400, 'RESET_TOKEN_INVALID', 'This password reset link is invalid or expired.');
      }
      const userId = action.rows[0].user_id;
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      await client.query(
        `UPDATE auth_email_tokens SET used_at = NOW(), token_ciphertext = NULL
         WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
        [userId],
      );
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
      return response.json({ reset: true, sessionsRevoked: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/me', (request, response, next) => loadSession(pool, request, response, next), async (request, response, next) => {
    const { user_id, full_name, email, organization_id, organization_name, business_type, country_code, access_role, is_platform_admin, mfa_enabled } = request.auth;
    try {
      const pending = await pendingLegalDocuments(pool, user_id, access_role);
      return response.json({
        user: { id: user_id, fullName: full_name, email, isPlatformAdmin: is_platform_admin, mfaEnabled: Boolean(mfa_enabled) },
        organization: { id: organization_id, name: organization_name, businessType: business_type, countryCode: country_code, accessRole: access_role },
        capabilities: capabilitiesFor(access_role),
        account: {
          deletionRequestedAt: request.auth.deletion_requested_at ?? null,
          deletionScheduledFor: request.auth.deletion_scheduled_for ?? null,
          organizationClosureScheduledFor: request.auth.closure_scheduled_for ?? null,
        },
        pendingLegalDocuments: pending.map((row) => legalDocumentDto(row)),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/organizations', (request, response, next) => loadSession(pool, request, response, next), (request, response, next) => requireActiveAccount(pool, request, response, next), async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT organization.id, organization.name, organization.business_type, organization.country_code, membership.access_role
         FROM organization_memberships membership JOIN organizations organization ON organization.id = membership.organization_id
         WHERE membership.user_id = $1 AND organization.suspended_at IS NULL AND organization.closure_scheduled_for IS NULL
         ORDER BY organization.name, organization.id`,
        [request.auth.user_id],
      );
      return response.json({ organizations: result.rows.map((row) => ({ id: row.id, name: row.name, businessType: row.business_type, countryCode: row.country_code, accessRole: row.access_role })), activeOrganizationId: request.auth.organization_id });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/organizations/:organizationId/switch', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, (request, response, next) => requireActiveAccount(pool, request, response, next), async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.organizationId).success) return apiError(response, 400, 'VALIDATION_ERROR', 'Choose a valid organization.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query(
        `SELECT organization.id, organization.name, organization.business_type, organization.country_code, membership.access_role
         FROM organization_memberships membership JOIN organizations organization ON organization.id = membership.organization_id
         WHERE membership.user_id = $1 AND membership.organization_id = $2
           AND organization.suspended_at IS NULL AND organization.closure_scheduled_for IS NULL
         FOR UPDATE OF membership`,
        [request.auth.user_id, request.params.organizationId],
      );
      if (!target.rowCount) {
        await client.query('ROLLBACK');
        return apiError(response, 404, 'ORGANIZATION_NOT_AVAILABLE', 'This organization is not available to your account.');
      }
      const organization = target.rows[0];
      if (organization.id === request.auth.organization_id) {
        await client.query('ROLLBACK');
        return response.json({ organization: { id: organization.id, name: organization.name, businessType: organization.business_type, countryCode: organization.country_code, accessRole: organization.access_role }, csrfToken: request.auth.csrf_token });
      }
      const session = await saveSession(client, request.auth.user_id, organization.id);
      await client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [request.sessionTokenHash]);
      await client.query('COMMIT');
      createSessionCookie(response, session.token, cookieName, secureCookies);
      return response.json({ organization: { id: organization.id, name: organization.name, businessType: organization.business_type, countryCode: organization.country_code, accessRole: organization.access_role }, csrfToken: session.csrfToken });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  const invitationTokenSchema = z.string().min(20).max(200);
  const invitationAcceptSchema = z.object({
    token: invitationTokenSchema,
    full_name: z.string().trim().min(2, 'Enter a name between 2 and 120 characters.').max(120, 'Enter a name between 2 and 120 characters.').optional(),
    password: z.string().min(8, 'Password must be at least 8 characters.').refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be no more than 72 bytes.').optional(),
    accepted_legal_document_ids: z.array(z.uuid()).max(20).default([]),
  }).refine((value) => Boolean(value.full_name) === Boolean(value.password), 'Provide both a name and password for a new account.');

  async function findPendingInvitation(db, token, lock = false) {
    const result = await db.query(
      `SELECT i.id, i.organization_id, i.email, i.access_role, i.expires_at, o.name AS organization_name, o.business_type
       FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
       ${lock ? 'FOR UPDATE OF i' : ''}`,
      [hashEmailActionToken(token)],
    );
    return result.rows[0] ?? null;
  }

  router.get('/invitations/preview', authLimiter, async (request, response, next) => {
    const token = invitationTokenSchema.safeParse(request.query.token);
    if (!token.success) return apiError(response, 400, 'VALIDATION_ERROR', 'This invitation link is incomplete.');
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable until the database is configured.');
    try {
      const invitation = await findPendingInvitation(pool, token.data);
      if (!invitation) return apiError(response, 404, 'INVITATION_NOT_FOUND', 'This invitation is invalid, expired, revoked or already used.');
      return response.json({ invitation: { organizationName: invitation.organization_name, businessType: invitation.business_type, email: invitation.email, role: invitation.access_role, expiresAt: invitation.expires_at } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/invitations/accept', authLimiter, async (request, response, next) => {
    const input = parseWith(invitationAcceptSchema, request.body);
    if (input.error) return apiError(response, 400, 'VALIDATION_ERROR', input.error);
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable until the database is configured.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invitation = await findPendingInvitation(client, input.data.token, true);
      if (!invitation) {
        await client.query('ROLLBACK');
        return apiError(response, 404, 'INVITATION_NOT_FOUND', 'This invitation is invalid, expired, revoked or already used.');
      }
      const sessionToken = request.cookies?.[cookieName];
      const currentSession = sessionToken ? await client.query(
        `SELECT session.token_hash, session.csrf_token, account.id AS user_id, account.email
         FROM auth_sessions session JOIN users account ON account.id = session.user_id
         JOIN organizations organization ON organization.id = session.organization_id
         WHERE session.token_hash = $1 AND session.expires_at > NOW() AND account.email_verified_at IS NOT NULL
           AND account.deletion_requested_at IS NULL AND organization.suspended_at IS NULL
         LIMIT 1`,
        [hashToken(sessionToken)],
      ) : { rows: [] };
      const authenticatedUser = currentSession.rows[0] ?? null;
      if (authenticatedUser && !safeEqual(request.get('x-csrf-token'), authenticatedUser.csrf_token)) {
        await client.query('ROLLBACK');
        return apiError(response, 403, 'CSRF_INVALID', 'Refresh your session and try again.');
      }
      const missing = await missingAcceptances(client, input.data.accepted_legal_document_ids, invitation.access_role);
      if (missing.length) {
        await client.query('ROLLBACK');
        return apiError(response, 400, 'LEGAL_ACCEPTANCE_REQUIRED', `Accept the current ${missing.map((row) => row.title).join(', ')} to join.`);
      }
      const existingUser = await client.query('SELECT id, full_name FROM users WHERE email = $1', [invitation.email]);
      let userId;
      let switchedSession = null;
      if (existingUser.rowCount) {
        if (!authenticatedUser) {
          await client.query('ROLLBACK');
          return apiError(response, 401, 'SIGN_IN_REQUIRED', 'Sign in to the invited account before accepting this invitation.');
        }
        if (authenticatedUser.user_id !== existingUser.rows[0].id) {
          await client.query('ROLLBACK');
          return apiError(response, 403, 'INVITATION_EMAIL_MISMATCH', 'Sign in with the email address that received this invitation.');
        }
        const alreadyMember = await client.query(
          'SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2',
          [invitation.organization_id, authenticatedUser.user_id],
        );
        if (alreadyMember.rowCount) {
          await client.query('ROLLBACK');
          return apiError(response, 409, 'ALREADY_MEMBER', 'You are already a member of this organization.');
        }
        userId = authenticatedUser.user_id;
        await client.query(
          'INSERT INTO organization_memberships (id, organization_id, user_id, access_role) VALUES ($1, $2, $3, $4)',
          [randomUUID(), invitation.organization_id, userId, invitation.access_role],
        );
        switchedSession = await saveSession(client, userId, invitation.organization_id);
        await client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [authenticatedUser.token_hash]);
      } else {
        if (authenticatedUser) {
          await client.query('ROLLBACK');
          return apiError(response, 403, 'INVITATION_EMAIL_MISMATCH', 'Sign out before creating an account for a different invitation email.');
        }
        if (!input.data.full_name || !input.data.password) {
          await client.query('ROLLBACK');
          return apiError(response, 400, 'VALIDATION_ERROR', 'Enter your name and create a password to finish account setup.');
        }
        userId = randomUUID();
        const passwordHash = await bcrypt.hash(input.data.password, passwordWorkFactor);
        // The single-use token was issued for this address by a verified organization manager.
        await client.query(
          'INSERT INTO users (id, full_name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, NOW())',
          [userId, input.data.full_name, invitation.email, passwordHash],
        );
        await client.query(
          'INSERT INTO organization_memberships (id, organization_id, user_id, access_role) VALUES ($1, $2, $3, $4)',
          [randomUUID(), invitation.organization_id, userId, invitation.access_role],
        );
      }
      await client.query('UPDATE organization_invitations SET accepted_at = NOW(), accepted_user_id = $2 WHERE id = $1', [invitation.id, userId]);
      await recordAcceptances(client, { userId, organizationId: invitation.organization_id, documentIds: input.data.accepted_legal_document_ids });
      await recordOrganizationEvent(client, { organizationId: invitation.organization_id, actorUserId: userId, action: 'invitation.accepted', targetUserId: userId, details: { email: invitation.email, role: invitation.access_role } });
      await client.query('COMMIT');
      if (switchedSession) createSessionCookie(response, switchedSession.token, cookieName, secureCookies);
      if (switchedSession) return response.status(201).json({ email: invitation.email, user: { id: userId, fullName: existingUser.rows[0].full_name }, organization: { id: invitation.organization_id, name: invitation.organization_name, businessType: invitation.business_type, accessRole: invitation.access_role }, csrfToken: switchedSession.csrfToken, switchedOrganization: true });
      return response.status(201).json({ email: invitation.email, organizationName: invitation.organization_name, businessType: invitation.business_type, role: invitation.access_role });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return apiError(response, 409, 'EMAIL_IN_USE', 'An account already uses this email. Sign in instead.');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/csrf', (request, response, next) => loadSession(pool, request, response, next), (request, response) => {
    response.json({ csrfToken: request.auth.csrf_token });
  });

  router.post('/logout', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, async (request, response, next) => {
    try {
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [request.sessionTokenHash]);
      response.clearCookie(cookieName, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/sessions', (request, response, next) => loadSession(pool, request, response, next), (request, response, next) => requireActiveAccount(pool, request, response, next), async (request, response, next) => {
    try {
      const sessions = await pool.query(
        `SELECT session.id, session.organization_id, organization.name AS organization_name,
                organization.business_type, session.created_at, session.expires_at
         FROM auth_sessions session JOIN organizations organization ON organization.id = session.organization_id
         WHERE session.user_id = $1 AND session.expires_at > NOW()
         ORDER BY session.created_at DESC, session.id DESC`,
        [request.auth.user_id],
      );
      response.set('Cache-Control', 'private, no-store');
      return response.json({ sessions: sessions.rows.map((session) => ({
        id: session.id,
        organizationId: session.organization_id,
        organizationName: session.organization_name,
        businessType: session.business_type,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        current: session.id === request.auth.session_id,
      })) });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/sessions/:sessionId', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, (request, response, next) => requireActiveAccount(pool, request, response, next), async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.sessionId).success) return apiError(response, 400, 'VALIDATION_ERROR', 'Choose a valid session.');
    try {
      const removed = await pool.query(
        'DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2 RETURNING id',
        [request.params.sessionId, request.auth.user_id],
      );
      if (!removed.rowCount) return apiError(response, 404, 'SESSION_NOT_FOUND', 'Active session was not found.');
      if (request.params.sessionId === request.auth.session_id) response.clearCookie(cookieName, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/sessions/sign-out-everywhere', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, (request, response, next) => requireActiveAccount(pool, request, response, next), async (request, response, next) => {
    try {
      const removed = await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [request.auth.user_id]);
      response.clearCookie(cookieName, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
      return response.json({ revokedSessions: removed.rowCount });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/profile', (request, response, next) => loadSession(pool, request, response, next), async (request, response, next) => {
    if (request.auth.business_type === 'agency') return apiError(response, 403, 'ROLE_FORBIDDEN', 'Seller profiles are only available to DMCs and hoteliers.');
    try {
      const profile = await sellerProfileResponse(pool, request.auth.organization_id);
      if (!profile) return apiError(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      return response.json(profile);
    } catch (error) {
      return next(error);
    }
  });

  const profileSchema = z.object({
    coverage_destination_ids: registrationExtrasSchema.shape.coverage_destination_ids,
    coverage: z.array(z.object({
      destination_id: destinationIdSchema,
      mode: z.enum(coverageModes.map((mode) => mode.value)).default('include'),
    })).max(config.maxCoverageDestinations, `Choose up to ${config.maxCoverageDestinations} coverage rules.`).optional(),
    property_destination_id: destinationIdSchema.nullish(),
  });

  router.put('/profile', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, (request, response, next) => requireActiveAccount(pool, request, response, next), requireCapability(capabilities.profileManage), async (request, response, next) => {
    if (request.auth.business_type === 'agency') return apiError(response, 403, 'ROLE_FORBIDDEN', 'Seller profiles are only available to DMCs and hoteliers.');
    const input = parseWith(profileSchema, request.body);
    if (input.error) return apiError(response, 400, 'VALIDATION_ERROR', input.error);
    const isDmc = request.auth.business_type === 'dmc';
    const coverageRules = isDmc
      ? normalizeCoverageRules(input.data.coverage
        ? input.data.coverage.map((rule) => ({ destinationId: rule.destination_id, mode: rule.mode }))
        : input.data.coverage_destination_ids)
      : [];
    const coverageIds = coverageRules.map((rule) => rule.destinationId);
    const propertyDestinationId = isDmc ? null : input.data.property_destination_id ?? null;
    if (isDmc && !coverageRules.some((rule) => rule.mode === 'include')) return apiError(response, 400, 'VALIDATION_ERROR', 'Add at least one destination to your coverage.');
    if (!isDmc && !propertyDestinationId) return apiError(response, 400, 'VALIDATION_ERROR', 'Choose the city where your property is located.');
    const client = await pool.connect();
    try {
      const coverage = await resolveActiveDestinations(client, coverageIds);
      if (coverage.error) return apiError(response, 400, 'VALIDATION_ERROR', coverage.error);
      const property = await resolveActiveDestinations(client, propertyDestinationId ? [propertyDestinationId] : [], { kinds: propertyDestinationKinds });
      if (property.error) return apiError(response, 400, 'VALIDATION_ERROR', property.error);
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT property_destination_id, verification_status FROM seller_profiles WHERE organization_id = $1 FOR UPDATE',
        [request.auth.organization_id],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return apiError(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      }
      const previousCoverage = await loadCoverage(client, request.auth.organization_id);
      const previousProfile = {
        coverageDestinationIds: previousCoverage.map((row) => `${row.id}:${row.mode}`).sort(),
        coverageDestinations: previousCoverage.map((row) => row.name),
        propertyDestinationId: current.rows[0].property_destination_id,
      };
      const updatedProfile = {
        coverageDestinationIds: coverageRules.map((rule) => `${rule.destinationId}:${rule.mode}`).sort(),
        coverageDestinations: coverage.rows.map((row) => row.name),
        propertyDestinationId,
        propertyCity: property.rows[0]?.name ?? null,
      };
      const changed = JSON.stringify(previousProfile.coverageDestinationIds) !== JSON.stringify(updatedProfile.coverageDestinationIds)
        || previousProfile.propertyDestinationId !== updatedProfile.propertyDestinationId;
      if (!changed) {
        await client.query('COMMIT');
        return response.json({ ...(await sellerProfileResponse(client, request.auth.organization_id)), changed: false });
      }

      await client.query(
        `INSERT INTO seller_profile_changes (id, seller_organization_id, changed_by_user_id, previous_profile, updated_profile)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), request.auth.organization_id, request.auth.user_id, JSON.stringify(previousProfile), JSON.stringify(updatedProfile)],
      );
      await client.query(
        `UPDATE seller_profiles SET property_destination_id = $2, property_city = $3,
           verification_status = 'pending', verification_reason = 'Seller profile changed and requires a new review.', updated_at = NOW()
         WHERE organization_id = $1`,
        [request.auth.organization_id, updatedProfile.propertyDestinationId, updatedProfile.propertyCity],
      );
      await replaceCoverage(client, request.auth.organization_id, coverageRules);
      if (!isDmc && previousProfile.propertyDestinationId !== updatedProfile.propertyDestinationId) {
        await client.query(
          `UPDATE hotel_properties SET destination_id = $2, verification_status = 'pending', updated_at = NOW()
           WHERE id = (SELECT id FROM hotel_properties WHERE organization_id = $1 ORDER BY created_at, id LIMIT 1)`,
          [request.auth.organization_id, updatedProfile.propertyDestinationId],
        );
      }
      const withdrawn = await client.query(
        `UPDATE offers offer SET status = 'withdrawn', updated_at = NOW()
         FROM marketplace_requests request WHERE offer.request_id = request.id
           AND offer.seller_organization_id = $1 AND offer.status IN ('submitted', 'shortlisted')
           AND request.status = 'open'
         RETURNING offer.id, offer.request_id, request.request_code, request.agency_organization_id`,
        [request.auth.organization_id],
      );
      for (const offer of withdrawn.rows) {
        await client.query(
          `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
           VALUES ($1, $2, 'seller_profile_changed', 'Seller profile updated', $3, $4)`,
          [randomUUID(), offer.agency_organization_id, `${offer.request_code} / Seller profile changed; offer withdrawn pending review.`, JSON.stringify({ offerId: offer.id, requestId: offer.request_id, requestCode: offer.request_code })],
        );
      }
      await client.query(
        `UPDATE request_targets SET declined_at = NOW(), decline_reason = $2
         WHERE seller_organization_id = $1 AND declined_at IS NULL
           AND request_id IN (SELECT id FROM marketplace_requests WHERE status = 'open')`,
        [request.auth.organization_id, `${routingDeclinePrefix} Seller profile changed; re-evaluation required.`],
      );
      await client.query('COMMIT');
      return response.json({ ...(await sellerProfileResponse(client, request.auth.organization_id)), changed: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}