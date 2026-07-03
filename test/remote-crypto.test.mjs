import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSessionKey,
  generateKeyPair,
  open,
  privateKeyFromPem,
  publicKeyFromRaw,
  seal,
} from "../remote/daemon/src/crypto.mjs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";

test("E2E 加密：daemon 与 client 双向密钥一致且可互解", () => {
  const daemonId = "test-daemon-id";
  const daemon = generateKeyPair();
  const client = generateKeyPairSync("x25519");
  const clientPubRaw = (() => {
    const spki = client.publicKey.export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(spki.length - 32));
  })();

  const daemonKey = deriveSessionKey(privateKeyFromPem(daemon.privateKeyPem), clientPubRaw, daemonId);
  const clientKey = deriveSessionKey(client.privateKey, daemon.publicKeyRaw, daemonId);
  assert.deepEqual(daemonKey, clientKey);

  const message = { id: 1, method: "auth", params: { pairToken: "秘密" } };
  const envelope = seal(clientKey, "c2d", message);
  assert.deepEqual(open(daemonKey, "c2d", envelope), message);

  const reply = { id: 1, result: { ok: true } };
  const replyEnvelope = seal(daemonKey, "d2c", reply);
  assert.deepEqual(open(clientKey, "d2c", replyEnvelope), reply);
});

test("E2E 加密：方向 AAD 不匹配时解密失败（防反射）", () => {
  const daemonId = "d1";
  const daemon = generateKeyPair();
  const client = generateKeyPairSync("x25519");
  const clientPubRaw = (() => {
    const spki = client.publicKey.export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(spki.length - 32));
  })();
  const key = deriveSessionKey(client.privateKey, daemon.publicKeyRaw, daemonId);
  const envelope = seal(key, "c2d", { a: 1 });
  assert.throws(() => open(key, "d2c", envelope));
});

test("E2E 加密：篡改密文解密失败", () => {
  const daemon = generateKeyPair();
  const client = generateKeyPairSync("x25519");
  const clientPubRaw = (() => {
    const spki = client.publicKey.export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(spki.length - 32));
  })();
  const key = deriveSessionKey(client.privateKey, daemon.publicKeyRaw, "d1");
  const envelope = seal(key, "c2d", { a: 1 });
  const corrupted = Buffer.from(envelope.c, "base64");
  corrupted[0] ^= 0xff;
  assert.throws(() => open(key, "c2d", { n: envelope.n, c: corrupted.toString("base64") }));
});

test("publicKeyFromRaw 拒绝错误长度", () => {
  assert.throws(() => publicKeyFromRaw(Buffer.alloc(16)));
});

test("私钥 PEM 往返", () => {
  const pair = generateKeyPair();
  const restored = privateKeyFromPem(pair.privateKeyPem);
  assert.equal(restored.asymmetricKeyType, "x25519");
  assert.ok(createPrivateKey(pair.privateKeyPem));
});
