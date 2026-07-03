// 端到端加密：X25519 + HKDF-SHA256 + AES-256-GCM（见 remote/PROTOCOL.md §2）
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const HKDF_INFO = "codex-zh-remote-v1";
const AAD_C2D = Buffer.from("czr1:c2d");
const AAD_D2C = Buffer.from("czr1:d2c");

// X25519 raw 公钥 <-> KeyObject。Node 以 SPKI DER 表示，raw 32 字节位于末尾。
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyRaw: exportPublicKeyRaw(publicKey),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function exportPublicKeyRaw(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function publicKeyFromRaw(raw) {
  if (raw.length !== 32) {
    throw new Error(`X25519 公钥长度错误: ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function privateKeyFromPem(pem) {
  return createPrivateKey(pem);
}

// 派生本连接会话密钥。privateKey: KeyObject；peerPublicRaw: Buffer(32)；daemonId: string
export function deriveSessionKey(privateKey, peerPublicRaw, daemonId) {
  const shared = diffieHellman({
    privateKey,
    publicKey: publicKeyFromRaw(peerPublicRaw),
  });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(daemonId), HKDF_INFO, 32));
}

function aad(direction) {
  if (direction === "c2d") return AAD_C2D;
  if (direction === "d2c") return AAD_D2C;
  throw new Error(`未知加密方向: ${direction}`);
}

// 加密 JSON 对象 -> {n, c}
export function seal(key, direction, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(direction));
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { n: iv.toString("base64"), c: ciphertext.toString("base64") };
}

// 解密 {n, c} -> JSON 对象；认证失败抛错
export function open(key, direction, envelope) {
  const iv = Buffer.from(envelope.n, "base64");
  const data = Buffer.from(envelope.c, "base64");
  if (iv.length !== 12 || data.length < 16) {
    throw new Error("信封格式错误");
  }
  const ciphertext = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(direction));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString());
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomId(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}
