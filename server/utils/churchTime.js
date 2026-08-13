'use strict';

const tzLookup = require('tz-lookup');

const DEFAULT_TIME_ZONE = 'UTC';
const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeTimeZone(value, fallback = DEFAULT_TIME_ZONE) {
  if (typeof value === 'string' && value.trim()) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
      return value;
    } catch (_) {}
  }
  return fallback === value ? DEFAULT_TIME_ZONE : normalizeTimeZone(fallback, DEFAULT_TIME_ZONE);
}

function timeZoneFromCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    const error = new RangeError('Latitude/longitude out of range');
    error.code = 'INVALID_COORDINATES';
    throw error;
  }
  return normalizeTimeZone(tzLookup(lat, lng));
}

function getZonedParts(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid instant');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAY_INDEX[values.weekday],
  };
}

function getChurchDate(instant, timeZone) {
  const { year, month, day } = getZonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseSqliteUtc(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = typeof value === 'string' && SQLITE_UTC.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateOnly(value) {
  const match = typeof value === 'string' && DATE_ONLY.exec(value);
  if (!match) throw new TypeError('Invalid date-only value');

  const [, year, month, day] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('Invalid date-only value');
  }
  return { year, month, day };
}

function formatDateOnly(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function daysInDateOnlyMonth(value) {
  const { year, month } = parseDateOnly(value);
  return daysInMonth(year, month);
}

function dateAmount(value, key) {
  const amount = value[key];
  if (amount === undefined) return 0;
  if (!Number.isInteger(amount)) throw new TypeError(`Invalid ${key} amount`);
  return amount;
}

function addDateOnly(value, amount = {}) {
  if (!amount || typeof amount !== 'object') throw new TypeError('Invalid date-only amount');
  const { year, month, day } = parseDateOnly(value);
  const days = dateAmount(amount, 'days');
  const months = dateAmount(amount, 'months');
  const years = dateAmount(amount, 'years');
  const targetMonth = (year + years) * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetMonth / 12);
  const targetMonthIndex = ((targetMonth % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonthIndex + 1));
  const date = new Date(0);
  date.setUTCFullYear(targetYear, targetMonthIndex, targetDay);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

async function loadChurchTimeZone(churchId) {
  const Database = require('../config/database');
  const rows = await Database.queryForChurch(
    churchId,
    'SELECT timezone FROM church_settings WHERE church_id = ? LIMIT 1',
    [churchId]
  );
  return normalizeTimeZone(rows[0]?.timezone);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  timeZoneFromCoordinates,
  getZonedParts,
  getChurchDate,
  parseSqliteUtc,
  addDateOnly,
  daysInDateOnlyMonth,
  loadChurchTimeZone,
};
