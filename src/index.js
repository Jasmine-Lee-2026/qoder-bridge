// Entrypoint.
//   npm start            serve the OpenAI-compatible bridge + control page
//   npm run login        CLI device-flow login (writes ~/.qoder-bridge/auth.json)
//   npm run refresh      force a token refresh attempt
//   npm run info         print auth status (token masked)
import { start } from './server.js';
import { deviceLogin, refresh, authInfo, loadAuth } from './auth.js';

const arg = process.argv[2];

if (arg === '--login') {
  deviceLogin()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('login failed:', e.message);
      process.exit(1);
    });
} else if (arg === '--refresh') {
  refresh()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('refresh failed:', e.message);
      process.exit(1);
    });
} else if (arg === '--info') {
  console.log(JSON.stringify(authInfo(), null, 2));
  process.exit(0);
} else {
  // The server always starts: the control page (GET /) is the recovery path
  // when no token is present, so refusing to boot would hide it.
  if (!loadAuth()) {
    console.log('no token yet - open http://127.0.0.1:9528/ and click "Renew token"');
  }
  start();
}
