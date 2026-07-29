const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    .select('role, status')
    .eq('auth_user_id', callerUser.user.id)
    .maybeSingle();

  if (callerStaffErr || !callerStaff || callerStaff.status !== 'active' || !['admin', 'director', 'it'].includes(callerStaff.role)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin, Director, or IT can restore staff' }) };
  }

  const { data: targetStaff, error: targetErr } = await admin
    .from('staff')
    .select('id, auth_user_id, status')
    .eq('id', staffId)
    .maybeSingle();

  if (targetErr || !targetStaff) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Staff record not found' }) };
  }

  if (targetStaff.status === 'active') {
    return { statusCode: 400, body: JSON.stringify({ error: 'This staff member is already active.' }) };
  }

  const { error: restoreErr } = await admin
    .from('staff')
    .update({ status: 'active', archived_at: null })
    .eq('id', staffId);

  if (restoreErr) {
    return { statusCode: 400, body: JSON.stringify({ error: restoreErr.message }) };
  }

  if (targetStaff.auth_user_id) {
    const { error: unbanErr } = await admin.auth.admin.updateUserById(targetStaff.auth_user_id, {
      ban_duration: 'none'
    });
    if (unbanErr) {
      return { statusCode: 207, body: JSON.stringify({ success: true, warning: 'Staff member restored, but their login could not be re-enabled: ' + unbanErr.message }) };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
