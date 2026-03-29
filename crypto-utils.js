'use strict';

const crypto = require('crypto');
const fs = require('fs');

function deriveKey(myKeyPath, peerCertPath) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(myKeyPath));
  const publicKey = crypto.createPublicKey(fs.readFileSync(peerCertPath));
  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey });
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, 'nfs-relay-salt', 'aes-key', 32));
}

function encrypt(key, json) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

function decrypt(key, line) {
  const buf = Buffer.from(line, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const encrypted = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
}

module.exports = { deriveKey, encrypt, decrypt };
