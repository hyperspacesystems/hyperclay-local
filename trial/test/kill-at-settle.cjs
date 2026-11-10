'use strict';

// A --require preloader for the trial service: while the file named by
// TRIAL_KILL_AT_SETTLE exists, a document's /v1/settle SIGKILLs the process, the
// way a service that dies with a settle in flight would, so Go is left holding
// the document unconfirmed.

const fs = require('node:fs');
const service = require('../service.cjs');

const createTrialService = service.createTrialService;

service.createTrialService = (options) => {
  const created = createTrialService(options);
  const settle = created.handlers.get('/v1/settle');
  created.handlers.set('/v1/settle', (body, reply) => {
    const marker = process.env.TRIAL_KILL_AT_SETTLE;
    if (marker && fs.existsSync(marker)) {
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    return settle(body, reply);
  });
  return created;
};
