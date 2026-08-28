'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyMonaSignature } = require('../hmac');
const { paymentReference } = require('../server');

const body = Buffer.from('{"amount":2500000,"description":"DH123","transaction_code":"FT26240001234","account_number":"MONA00000123","type":"income"}');
const timestamp = '1756355400';
const secret = '0123456789abcdef0123456789abcdef';
const known = 'sha256=c7b09ff9e0e8eaee7d31e9c35f08fb41222543b8d6e793f1c4eed5b23008d28a';

test('verify known MONA Pay HMAC vector', () => {
  assert.equal(verifyMonaSignature(body, timestamp, known, secret, 1756355400), true);
  assert.equal(verifyMonaSignature(Buffer.concat([body, Buffer.from(' ')]), timestamp, known, secret, 1756355400), false);
  assert.equal(verifyMonaSignature(body, timestamp, known, secret, 1756355701), false);
  assert.equal(verifyMonaSignature(body, timestamp, `sha256=${'0'.repeat(64)}`, secret, 1756355400), false);
});

test('parse explicit member payment reference', () => {
  assert.equal(paymentReference('Thanh toan MEMBER customer-0001'), 'customer-0001');
  assert.equal(paymentReference('no mapping'), null);
});
