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

  if (callerStaffErr || !callerStaff || !['admin', 'director', 'it'].includes(callerStaff.role)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin, Director, or IT can delete staff' }) };
  }

  // Look up the target staff row to get their auth_user_id before deleting.
  const { data: targetStaff, error: targetErr } = await admin
    .from('staff')
    .select('id, auth_user_id, role')
    .eq('id', staffId)
    .maybeSingle();

  if (targetErr || !targetStaff) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Staff record not found' }) };
  }

  if (targetStaff.auth_user_id === callerUser.user.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'You cannot delete your own staff record.' }) };
  }

  // Never allow the last remaining admin to be deleted.
  if (targetStaff.role === 'admin') {
    const { count } = await admin
      .from('staff')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .neq('id', staffId);
    if (!count) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Cannot delete: at least one Admin must remain in the system.' }) };
    }
  }

  // Delete the staff row first.
  const { error: deleteStaffErr } = await admin.from('staff').delete().eq('id', staffId);
  if (deleteStaffErr) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not delete staff record: ' + deleteStaffErr.message }) };
  }

  // Then delete their login, so no orphaned auth account is left behind.
  if (targetStaff.auth_user_id) {
    const { error: deleteAuthErr } = await admin.auth.admin.deleteUser(targetStaff.auth_user_id);
    if (deleteAuthErr) {
      // Staff row is already gone; surface this so it can be cleaned up manually if needed.
      return { statusCode: 207, body: JSON.stringify({ success: true, warning: 'Staff record deleted, but the login could not be removed: ' + deleteAuthErr.message }) };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
