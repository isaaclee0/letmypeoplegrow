function kioskModeEnabled() {
  return process.env.KIOSK_MODE_ENABLED === 'true';
}

module.exports = { kioskModeEnabled };
