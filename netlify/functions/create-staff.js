const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES = ['admin', 'admissions', 'education_lead', 'learning_coach', 'it', 'enrollment'];

function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let out = '';
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: missing service role key' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { accessToken, name, email, role } = body;

  if (!accessToken || !name || !email || !role) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (!VALID_ROLES.includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid role' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Verify the caller is a logged-in admin/IT staff member before doing anything privileged.
  const { data: callerUser, error: callerErr } = await admin.auth.getUser(accessToken);
  if (callerErr || !callerUser?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  const { data: callerStaff, error: callerStaffErr } = await admin
    .from('staff')
    .select('role')
    .eq('auth_user_id', callerUser.user.id)
    .maybeSingle();

  if (callerStaffErr || !callerStaff || !['admin', 'it'].includes(callerStaff.role)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin or IT can add staff' }) };
  }

  // Create the Supabase Auth account.
  const tempPassword = genTempPassword();
  const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true
  });

  if (createErr) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not create account: ' + createErr.message }) };
  }

  // Create the staff row linked to the new auth user.
  const { error: staffErr } = await admin.from('staff').insert({
    auth_user_id: newUser.user.id,
    name,
    role
  });

  if (staffErr) {
    // Roll back the auth account if the staff row fails, so we don't leave an orphaned login.
    await admin.auth.admin.deleteUser(newUser.user.id);
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not create staff record: ' + staffErr.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, email, tempPassword })
  };
};
