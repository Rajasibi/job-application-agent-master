const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', 'profile.json');

function loadUserProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error('Missing profile.json. Copy profile.example.json and enter only verified details.');
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('profile.json must contain a JSON object.');
  }
  return profile;
}

module.exports = { loadUserProfile };
