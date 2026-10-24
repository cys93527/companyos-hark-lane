import { requireRealDshApproval } from './real-dsh-approval.js';

const approval = requireRealDshApproval();
// Owned temporary roots only; production model configuration is not inherited.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|COS_MODEL|^DSH_/i.test(key)) delete process.env[key];
}
process.env['TEMP'] = approval.tempRoot;
process.env['TMP'] = approval.tempRoot;
process.env['TMPDIR'] = approval.tempRoot;
process.env['HOME'] = approval.tempRoot;
process.env['USERPROFILE'] = approval.tempRoot;
process.env['APPDATA'] = approval.tempRoot;
process.env['LOCALAPPDATA'] = approval.tempRoot;
