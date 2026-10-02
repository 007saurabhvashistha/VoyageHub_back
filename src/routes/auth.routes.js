import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { encryptEmailActionToken, hashEmailActionToken } from '../utils/emailActionTokens.js';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';
import { createRecoveryCodes, createTotpEnrollment, decryptTotpSecret, hashRecoveryCode, hashTotpCode, normalizeRecoveryCode, verifyTotpCode } from '../services/totp.js';

const allowedBusinessTypes = new Set(['agency', 'dmc', 'hotelier']);
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
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
    maxAge: 5 * 60 * 1000,
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
    [randomUUID(), userId, organizationId, hashToken(token), csrfToken, new Date(Date.now() + 5 * 60 * 1000)],
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
              u.full_name, u.email, o.id AS organization_id, o.name AS organization_name,
              o.business_type, o.country_code, m.access_role, COALESCE(mfa.enabled, FALSE) AS mfa_enabled
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

function validRegistration(body) {
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const organizationName = typeof body.organization_name === 'string' ? body.organization_name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const countryCode = typeof body.country_code === 'string' ? body.country_code.trim().toUpperCase() : '';
  const businessType = typeof body.business_type === 'string' ? body.business_type : '';
  const rawCoverage = typeof body.coverage_destinations === 'string' ? body.coverage_destinations.split(',') : [];
  const coverageDestinations = rawCoverage.map((destination) => destination.trim().toLowerCase()).filter(Boolean);
  const propertyCity = typeof body.property_city === 'string' ? body.property_city.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (fullName.length < 2 || fullName.length > 120) return { error: 'Enter a name between 2 and 120 characters.' };
  if (organizationName.length < 2 || organizationName.length > 160) return { error: 'Enter a business name between 2 and 160 characters.' };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid business email address.' };
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'Choose a valid country or region.' };
  if (!allowedBusinessTypes.has(businessType)) return { error: 'Choose a supported business type.' };
  if (businessType === 'dmc' && (coverageDestinations.length === 0 || coverageDestinations.length > 20 || coverageDestinations.some((destination) => destination.length > 100))) return { error: 'Add between 1 and 20 destination areas your DMC serves.' };
  if (businessType === 'hotelier' && (propertyCity.length < 2 || propertyCity.length > 120)) return { error: 'Enter the city where your property is located.' };
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return { error: 'Password must be at least 8 characters and no more than 72 bytes.' };

  return { fullName, organizationName, email, countryCode, businessType, password, coverageDestinations, propertyCity };
}

export function createAuthRouter({ pool, secureCookies, cookieName, emailDelivery = null, tokenEncryptionKey = null, mfaEncryptionKey = null }) {
  const router = Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
  });
  const emailActionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many email security requests. Try again later.' } },
  });
  const mfaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many MFA attempts. Try again later.' } },
  });

  router.post('/register', authLimiter, async (request, response, next) => {
    const input = validRegistration(request.body ?? {});
    if (input.error) return apiError(response, 400, 'VALIDATION_ERROR', input.error);
    if (!pool) return apiError(response, 503, 'DATABASE_NOT_CONFIGURED', 'Account service is unavailable until the database is configured.');
    if (!tokenEncryptionKey) return apiError(response, 503, 'EMAIL_SECURITY_NOT_CONFIGURED', 'Email verification cannot be started until the email-token encryption key is configured.');

    const client = await pool.connect();
    try {
      const passwordHash = await bcrypt.hash(input.password, passwordWorkFactor);
      const organizationId = randomUUID();
      const userId = randomUUID();
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organizations (id, name, business_type, country_code) VALUES ($1, $2, $3, $4)',
        [organizationId, input.organizationName, input.businessType, input.countryCode],
      );
      await client.query(
        'INSERT INTO users (id, full_name, email, password_hash) VALUES ($1, $2, $3, $4)',
        [userId, input.fullName, input.email, passwordHash],
      );
      await client.query(
        "INSERT INTO organization_memberships (id, organization_id, user_id, access_role) VALUES ($1, $2, $3, 'owner')",
        [randomUUID(), organizationId, userId],
      );
      if (input.businessType !== 'agency') {
        await client.query(
          'INSERT INTO seller_profiles (organization_id, coverage_destinations, property_city) VALUES ($1, $2, $3)',
          [organizationId, input.coverageDestinations, input.businessType === 'hotelier' ? input.propertyCity : null],
        );
      }
      await queueEmailAction(client, { userId, organizationId, purpose: 'verify_email', tokenEncryptionKey });
      await client.query('COMMIT');
      return response.status(201).json({
        user: { id: userId, fullName: input.fullName, email: input.email, isPlatformAdmin: false },
        organization: { id: organizationId, name: input.organizationName, businessType: input.businessType, countryCode: input.countryCode },
        verificationRequired: true,
        emailDeliveryStatus: emailDelivery ? 'queued' : 'blocked_config',
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return apiError(response, 409, 'EMAIL_IN_USE', 'An account already uses this email. Sign in or use another email.');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/login', authLimiter, async (request, response, next) => {
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
                o.business_type, o.country_code
         FROM users u
         JOIN organization_memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN user_mfa mfa ON mfa.user_id = u.id
         WHERE u.email = $1 AND o.business_type = $2
         LIMIT 1`,
        [email, businessType],
      );
      const user = account.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return apiError(response, 401, 'INVALID_CREDENTIALS', 'Email, password or business type is incorrect.');
      }
      if (!user.email_verified_at) return apiError(response, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.');

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

  router.get('/me', (request, response, next) => loadSession(pool, request, response, next), (request, response) => {
    const { user_id, full_name, email, organization_id, organization_name, business_type, country_code, access_role, is_platform_admin, mfa_enabled } = request.auth;
    response.json({
      user: { id: user_id, fullName: full_name, email, isPlatformAdmin: is_platform_admin, mfaEnabled: Boolean(mfa_enabled) },
      organization: { id: organization_id, name: organization_name, businessType: business_type, countryCode: country_code, accessRole: access_role },
    });
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

  router.get('/profile', (request, response, next) => loadSession(pool, request, response, next), async (request, response, next) => {
    if (request.auth.business_type === 'agency') return apiError(response, 403, 'ROLE_FORBIDDEN', 'Seller profiles are only available to DMCs and hoteliers.');
    try {
      const result = await pool.query(
        'SELECT coverage_destinations, property_city, verification_status, verification_reason FROM seller_profiles WHERE organization_id = $1',
        [request.auth.organization_id],
      );
      if (!result.rowCount) return apiError(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      const profile = result.rows[0];
      return response.json({ coverageDestinations: profile.coverage_destinations, propertyCity: profile.property_city, verificationStatus: profile.verification_status, verificationReason: profile.verification_reason });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/profile', (request, response, next) => loadSession(pool, request, response, next), requireCsrf, async (request, response, next) => {
    if (request.auth.business_type === 'agency') return apiError(response, 403, 'ROLE_FORBIDDEN', 'Seller profiles are only available to DMCs and hoteliers.');
    const coverageDestinations = Array.isArray(request.body?.coverage_destinations)
      ? [...new Set(request.body.coverage_destinations.map((destination) => typeof destination === 'string' ? destination.trim().toLowerCase() : ''))]
      : [];
    const propertyCity = typeof request.body?.property_city === 'string' ? request.body.property_city.trim() : '';
    if (coverageDestinations.length > 20 || coverageDestinations.some((destination) => destination.length < 2 || destination.length > 100)) return apiError(response, 400, 'VALIDATION_ERROR', 'Coverage must contain up to 20 destination names of 2 to 100 characters.');
    if (request.auth.business_type === 'dmc' && coverageDestinations.length === 0) return apiError(response, 400, 'VALIDATION_ERROR', 'Add at least one destination to your coverage.');
    if (request.auth.business_type === 'hotelier' && (propertyCity.length < 2 || propertyCity.length > 120)) return apiError(response, 400, 'VALIDATION_ERROR', 'Enter a property city between 2 and 120 characters.');
    const updatedProfile = { coverageDestinations, propertyCity: request.auth.business_type === 'hotelier' ? propertyCity : null };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT coverage_destinations, property_city, verification_status, verification_reason FROM seller_profiles WHERE organization_id = $1 FOR UPDATE',
        [request.auth.organization_id],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return apiError(response, 404, 'PROFILE_NOT_FOUND', 'Seller profile was not found.');
      }
      const previousProfile = { coverageDestinations: current.rows[0].coverage_destinations, propertyCity: current.rows[0].property_city };
      const changed = JSON.stringify(previousProfile.coverageDestinations) !== JSON.stringify(updatedProfile.coverageDestinations)
        || previousProfile.propertyCity !== updatedProfile.propertyCity;
      if (!changed) {
        await client.query('COMMIT');
        return response.json({ ...previousProfile, verificationStatus: current.rows[0].verification_status, verificationReason: current.rows[0].verification_reason, changed: false });
      }

      await client.query(
        `INSERT INTO seller_profile_changes (id, seller_organization_id, changed_by_user_id, previous_profile, updated_profile)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), request.auth.organization_id, request.auth.user_id, JSON.stringify(previousProfile), JSON.stringify(updatedProfile)],
      );
      await client.query(
        `UPDATE seller_profiles SET coverage_destinations = $2, property_city = $3,
           verification_status = 'pending', verification_reason = 'Seller profile changed and requires a new review.', updated_at = NOW()
         WHERE organization_id = $1`,
        [request.auth.organization_id, updatedProfile.coverageDestinations, updatedProfile.propertyCity],
      );
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
        `UPDATE request_targets SET declined_at = NOW(), decline_reason = 'Seller profile changed; re-evaluation required.'
         WHERE seller_organization_id = $1 AND declined_at IS NULL
           AND request_id IN (SELECT id FROM marketplace_requests WHERE status = 'open')`,
        [request.auth.organization_id],
      );
      await client.query('COMMIT');
      return response.json({ ...updatedProfile, verificationStatus: 'pending', verificationReason: 'Seller profile changed and requires a new review.', changed: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}