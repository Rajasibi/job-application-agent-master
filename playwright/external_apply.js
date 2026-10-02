// Employer / ATS job pages pasted by the user (not Naukri, Indeed or foundit).
// Runs the Round 11 application engine with no platform handler: bot-check detection first,
// then the agentic form-filler if a form is present. Never submits.
const { cli } = require('./application_engine');

if (require.main === module) cli('external', null);
