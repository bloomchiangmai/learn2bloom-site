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
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin, Director, or IT can archive staff' }) };
  }

  const { data: targetStaff, error: targetErr } = await admin
    .from('staff')
    .select('id, auth_user_id, role, status')
    .eq('id', staffId)
    .maybeSingle();

  if (targetErr || !targetStaff) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Staff record not found' }) };
  }

  if (targetStaff.auth_user_id === callerUser.user.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'You cannot archive your own staff record.' }) };
  }

  if (targetStaff.status === 'archived') {
    return { statusCode: 400, body: JSON.stringify({ error: 'This staff member is already archived.' }) };
  }

  // Archive the record. The staff_protect_last_admin_archiving trigger blocks
  // this if it would remove the last active Admin.
  const { error: archiveErr } = await admin
    .from('staff')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', staffId);

  if (archiveErr) {
    return { statusCode: 400, body: JSON.stringify({ error: archiveErr.message }) };
  }

  // Block their login without deleting the account, so it can be restored later.
  if (targetStaff.auth_user_id) {
    const { error: banErr } = await admin.auth.admin.updateUserById(targetStaff.auth_user_id, {
      ban_duration: '876000h' // effectively indefinite (100 years)
    });
    if (banErr) {
      return { statusCode: 207, body: JSON.stringify({ success: true, warning: 'Staff member archived, but their login could not be disabled: ' + banErr.message }) };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
