'use strict';

// A WebAuthn authenticator in software, for tests and for the live proof.
//
// This is not part of the product and nothing in `server.js` requires it. It
// exists because the alternative way to test a passkey implementation is to sit
// a person in front of a browser with a hardware key, which cannot be done on
// every commit, and because a test that mocks the verifier proves only that the
// mock agrees with itself.
//
// So this builds the real thing: a real P-256 key pair, a real clientDataJSON,
// real authenticator data with the right RP ID hash and flags, and a real
// ECDSA signature over the concatenation the specification names. The verifier
// under test is the actual one the product uses, and it has no idea the
// authenticator is not hardware. That makes the negative tests meaningful too:
// signing the wrong challenge, or for the wrong origin, produces a response
// that is well-formed and wrong, which is exactly the case a broken verifier
// would let through.
//
// It deliberately does not implement attestation beyond `none`, because that is
// what the product asks for and a fake attestation statement would be proving
// something nobody uses.

const crypto = require('crypto');

const b64url = buf => Buffer.from(buf).toString('base64url');

// COSE_Key for an EC2 P-256 public key, which is what an authenticator hands
// back and what the verifier has to parse. Written by hand rather than with a
// CBOR library so the test does not depend on the same code paths it is
// exercising.
function coseFromPublicKey(publicKeyDer) {
  const key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const raw = key.export({ format: 'jwk' });
  const x = Buffer.from(raw.x, 'base64url');
  const y = Buffer.from(raw.y, 'base64url');
  // CBOR map of five pairs: kty(1)=2, alg(3)=-7, crv(-1)=1, x(-2), y(-3).
  return Buffer.concat([
    Buffer.from([0xa5]),
    Buffer.from([0x01, 0x02]),
    Buffer.from([0x03, 0x26]),
    Buffer.from([0x20, 0x01]),
    Buffer.from([0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
}

function authenticatorData({ rpId, flags, counter, credentialId, cosePublicKey }) {
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter >>> 0, 0);
  const parts = [rpIdHash, Buffer.from([flags]), counterBuf];
  if (credentialId) {
    const aaguid = Buffer.alloc(16, 0);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credentialId.length, 0);
    parts.push(aaguid, idLen, credentialId, cosePublicKey);
  }
  return Buffer.concat(parts);
}

// Flags: user present, user verified, and attested credential data on the
// registration response.
const UP = 0x01, UV = 0x04, AT = 0x40;

function createSoftwareAuthenticator({ rpId, origin } = {}) {
  const credentials = new Map();

  function register({ challenge, rpId: rpOverride, origin: originOverride, credentialId } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const id = credentialId || crypto.randomBytes(16);
    const cose = coseFromPublicKey(publicKey.export({ format: 'der', type: 'spki' }));
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin: originOverride || origin,
      crossOrigin: false,
    }), 'utf8');
    const authData = authenticatorData({
      rpId: rpOverride || rpId, flags: UP | UV | AT, counter: 0,
      credentialId: id, cosePublicKey: cose,
    });
    // attestationObject: CBOR map { fmt: "none", attStmt: {}, authData: ... }
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      Buffer.from([0x63]), Buffer.from('fmt', 'utf8'), Buffer.from([0x64]), Buffer.from('none', 'utf8'),
      Buffer.from([0x67]), Buffer.from('attStmt', 'utf8'), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from('authData', 'utf8'), cborBytes(authData),
    ]);
    credentials.set(b64url(id), { privateKey, id, counter: 0 });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ['usb'],
      },
    };
  }

  function authenticate({ challenge, credential, rpId: rpOverride, origin: originOverride, counter, signChallenge, tamperSignature } = {}) {
    const held = credentials.get(credential);
    if (!held) throw new Error(`this authenticator holds no credential ${credential}`);
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      // `signChallenge` lets a test sign something other than what it presents,
      // which is the shape of a replay and of a relay attack.
      challenge: signChallenge || challenge,
      origin: originOverride || origin,
      crossOrigin: false,
    }), 'utf8');
    const nextCounter = counter === undefined ? ++held.counter : counter;
    const authData = authenticatorData({ rpId: rpOverride || rpId, flags: UP | UV, counter: nextCounter });
    const clientDataHash = crypto.createHash('sha256').update(clientData).digest();
    let signature = crypto.sign('sha256', Buffer.concat([authData, clientDataHash]), held.privateKey);
    if (tamperSignature) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 0xff;
    }
    return {
      id: b64url(held.id),
      rawId: b64url(held.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: null,
      },
    };
  }

  return { register, authenticate, credentials };
}

// CBOR byte string header for a buffer of this length, up to 64KB, which is
// more than any authData needs.
function cborBytes(buf) {
  if (buf.length < 24) return Buffer.concat([Buffer.from([0x40 | buf.length]), buf]);
  if (buf.length < 256) return Buffer.concat([Buffer.from([0x58, buf.length]), buf]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x59]), len, buf]);
}

module.exports = { createSoftwareAuthenticator };
