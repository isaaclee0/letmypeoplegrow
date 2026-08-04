'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFamilyName } = require('./familyName');

test('names a one-person family after the individual', () => {
  assert.equal(buildFamilyName([
    { firstName: 'Ada', lastName: 'Lovelace', child: false },
  ]), 'Lovelace, Ada');
});

test('uses adults first and children only when there are no adults', () => {
  assert.equal(buildFamilyName([
    { firstName: 'Child', lastName: 'Lovelace', child: true },
    { firstName: 'Ada', lastName: 'Lovelace', child: false },
    { firstName: 'Charles', lastName: 'Lovelace', child: false },
  ]), 'Lovelace, Ada and Charles');
  assert.equal(buildFamilyName([
    { firstName: 'One', lastName: 'Arroyo', child: true },
  ]), 'Arroyo, One');
});

test('returns an empty name when no member can provide one', () => {
  assert.equal(buildFamilyName([{ firstName: '', lastName: '', child: false }]), '');
});
