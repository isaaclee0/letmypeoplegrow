const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { verifyToken, requireRole } = require('../middleware/auth');
const Database = require('../config/database');
const referrals = require('../services/organisationReferrals');
const email = require('../utils/email');
const { getAppUrl } = require('../utils/appUrl');

const router = express.Router();
router.use(verifyToken, requireRole(['admin']));

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: req => req.user.church_id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Your organisation has reached its invitation limit. Please try again in an hour.' },
});

router.get('/', (req, res) => {
  res.json({ referrals: referrals.listForChurch(req.user.church_id) });
});

router.post('/',
  body('email').isString().bail().trim().isEmail().isLength({ max: 254 }).toLowerCase(),
  (req, res, next) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Enter a valid email address.' });
    next();
  },
  sendLimiter,
  async (req, res) => {
    let reservation;
    try {
      reservation = referrals.reserve(req.body.email, req.user);
      const signupLink = `${getAppUrl(req)}/signup?email=${encodeURIComponent(req.body.email)}`;
      await email.sendReferralEmail(req.body.email, signupLink, {
        name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || 'An admin',
        churchName: Database.getChurchName(req.user.church_id),
      });
      referrals.recordDelivery(reservation, req.user.church_id, true);
      res.status(201).json({ message: 'Invitation sent. Their organisation is pre-approved for 30 days.' });
    } catch (error) {
      if (reservation) referrals.recordDelivery(reservation, req.user.church_id, false);
      res.status(error.status || 502).json({
        error: error.status ? error.message : 'The invitation could not be sent. Please try again in a minute.',
      });
    }
  });

module.exports = router;
