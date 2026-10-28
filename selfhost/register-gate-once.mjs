import { provisionGateInstallation } from '../server/gate-client.js';
// No environment flag or HTTP route can turn ordinary startup into enrollment.
if (process.argv.length !== 3 || process.argv[2] !== '--register-once') {
  console.error('Explicit operator approval and --register-once are required. Never retry an uncertain registration.');
  process.exitCode = 2;
} else {
  try {
    const client = await provisionGateInstallation();
    console.log(JSON.stringify({ registrationRecorded: true, inboxId: client.inboxId, installationId: client.installationId, roomCreated: false, authorityGranted: false }));
    process.exit(0);
  } catch {
    console.error(JSON.stringify({ registrationRecorded: false, preserveState: true, doNotRetry: true }));
    process.exit(1);
  }
}
