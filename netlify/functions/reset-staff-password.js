const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const { accessToken, staffId } = body;
  if (!accessToken || !staffId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin or IT can reset passwords' }) };
  }

  const { data: targetStaff, error: targetErr } = await admin
    .from('staff')
    .select('auth_user_id, name')
    .eq('id', staffId)
    .maybeSingle();

  if (targetErr || !targetStaff) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Staff member not found' }) };
  }

  const tempPassword = genTempPassword();
  const { error: updateErr } = await admin.auth.admin.updateUserById(targetStaff.auth_user_id, {
    password: tempPassword
  });

  if (updateErr) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not reset password: ' + updateErr.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, name: targetStaff.name, tempPassword })
  };
};
