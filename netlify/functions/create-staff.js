const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ndlcfgkhxjoancdvmgmr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES = [
  'admin', 'director',
  'education_lead', 'education_consultant', 'lead_teacher',
  'learning_coach', 'learning_coach_assistant',
  'admissions', 'enrollment', 'front_desk',
  'it', 'teaching_assistant'
];

const ROLE_LABELS = {
  admin: 'Admin', director: 'Director',
  education_lead: 'Education Lead', education_consultant: 'Education Consultant', lead_teacher: 'Lead Teacher',
  learning_coach: 'Learning Coach', learning_coach_assistant: 'Learning Coach Assistant',
  admissions: 'Admissions Officer', enrollment: 'Enrollment Coordinator', front_desk: 'Front Desk / Office Manager',
  it: 'IT Support', teaching_assistant: 'Teaching Assistant'
};

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

  const { accessToken, name, email, role, password } = body;

  if (!accessToken || !name || !email || !role) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (password && password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
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

  if (callerStaffErr || !callerStaff || !['admin', 'director', 'it'].includes(callerStaff.role)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Only Admin, Director, or IT can add staff' }) };
  }

  // Create the Supabase Auth account and look up existing Staff IDs in parallel — independent of each other.
  const tempPassword = password || genTempPassword();
  const [{ data: newUser, error: createErr }, { data: existingStaff }] = await Promise.all([
    admin.auth.admin.createUser({ email, password: tempPassword, email_confirm: true }),
    admin.from('staff').select('staff_id_code')
  ]);

  if (createErr) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not create account: ' + createErr.message }) };
  }

  // Generate the next sequential Staff ID (e.g. BMSSTF03), permanent — no year component.
  let maxN = 0;
  (existingStaff || []).forEach(s => {
    const match = (s.staff_id_code || '').match(/^BMSSTF(\d+)$/);
    if (match) maxN = Math.max(maxN, parseInt(match[1], 10));
  });
  const staffIdCode = 'BMSSTF' + String(maxN + 1).padStart(2, '0');

  // Create the staff row linked to the new auth user.
  const { error: staffErr } = await admin.from('staff').insert({
    auth_user_id: newUser.user.id,
    name,
    role,
    job_title: ROLE_LABELS[role] || role,
    staff_id_code: staffIdCode
  });

  if (staffErr) {
    // Roll back the auth account if the staff row fails, so we don't leave an orphaned login.
    await admin.auth.admin.deleteUser(newUser.user.id);
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not create staff record: ' + staffErr.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, email, tempPassword, staffIdCode })
  };
};
// redeploy trigger 1785164373
