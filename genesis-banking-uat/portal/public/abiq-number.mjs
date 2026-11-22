// ISO 3166-1 alpha-2 codes from the IANA tz database country table.
export const ABIQ_COUNTRIES = Object.freeze(`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE
BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD
CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM
DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF
GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME
MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA
NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI
SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK
TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/));

export function abiqMod97(value) {
 if (typeof value !== 'string' || !/^[A-Z0-9]+$/.test(value)) {
  throw Object.assign(new Error('ABIQ_INVALID_CHARACTERS'), {code:'ABIQ_INVALID_CHARACTERS'});
 }
 let remainder = 0;
 for (const character of value) {
  const code = character.charCodeAt(0);
  remainder = code <= 57 ? (remainder * 10 + code - 48) % 97 : (remainder * 100 + code - 55) % 97;
 }
 return remainder;
}

export function ibanCheckDigits(country, bban) {
 return String(98 - abiqMod97(bban + country + '00')).padStart(2, '0');
}

export function buildAbiqNumber({country, holderCode, currencyBlock, series, customerNumber}) {
 const invalid = field => { throw Object.assign(new Error('INVALID_FIELD'), {field, code:'INVALID_FIELD', status:422}); };
 if (!ABIQ_COUNTRIES.includes(country)) invalid('country');
 if (!/^[A-Z]{4}$/.test(holderCode) || typeof holderCode !== 'string') invalid('holderCode');
 if (typeof currencyBlock !== 'string' || !/^000[0-9]{3}$/.test(currencyBlock)) invalid('currency');
 if (typeof series !== 'string' || !/^[0-9]{5}$/.test(series) || series === '00000') invalid('series');
 if (!['string','number'].includes(typeof customerNumber) || !/^[0-9]{7}$/.test(customerNumber) || Number(customerNumber) < 1000101) invalid('customerNumber');
 const bban = holderCode + currencyBlock + series + customerNumber;
 return country + ibanCheckDigits(country, bban) + bban;
}
