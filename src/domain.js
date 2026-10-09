'use strict';
const CURRENCY = /^[A-Z0-9]{3,12}$/;
function currency(code) {
  if (typeof code !== 'string' || !CURRENCY.test(code)) throw new Error('INVALID_CURRENCY');
  return code;
}
function minorUnits(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('INVALID_AMOUNT');
  const n = BigInt(value);
  if (n > 9223372036854775807n) throw new Error('AMOUNT_OVERFLOW');
  return n;
}
function balanced(entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('INSUFFICIENT_ENTRIES');
  const currencies = new Set();
  let net = 0n;
  for (const e of entries) {
    currencies.add(currency(e.currency));
    if (!['debit','credit'].includes(e.side)) throw new Error('INVALID_SIDE');
    const amount = minorUnits(e.amountMinor);
    net += e.side === 'debit' ? amount : -amount;
  }
  if (currencies.size !== 1) throw new Error('CROSS_CURRENCY_JOURNAL');
  if (net !== 0n) throw new Error('UNBALANCED_JOURNAL');
  return true;
}
module.exports = {currency, minorUnits, balanced};
