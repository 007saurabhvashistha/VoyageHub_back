import 'dotenv/config';
import { createDatabase } from '../src/db/connect.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run admin:demote -- operator@example.com');
  process.exitCode = 1;
} else {
  const { pool, close } = await createDatabase();
  try {
    const result = await pool.query('UPDATE users SET is_platform_admin = FALSE WHERE email = $1 AND is_platform_admin = TRUE RETURNING id', [email]);
    console.log(result.rowCount ? 'Platform admin access revoked.' : 'No platform admin access found for that email.');
  } catch {
    console.error('Admin demotion failed. Verify database access.');
    process.exitCode = 1;
  } finally {
    await close();
  }
}