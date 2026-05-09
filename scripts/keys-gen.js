#!/usr/bin/env node
/**
 * keys-gen.js — generate an Ed25519 alchemist keypair.
 *
 * Writes:
 *   ~/.config/swf/.alchemists.yml          (or merges into existing)  —
 *     adds our public key under the supplied alchemist id
 *   <repo>/cohort-data/.private/<id>.ed25519.json — private+public seed
 *     bytes, base64. Gitignored — see cohort-data/.gitignore.
 *
 * Usage:
 *   node scripts/keys-gen.js <id>          # default id is the OS user
 *   node scripts/keys-gen.js --print       # don't write, just dump
 *
 * The .alchemists.yml format swf-node expects (per spec §3.7):
 *   schema_version: 1
 *   alchemists:
 *     - id: dmarz
 *       pubkey: "ed25519:<64 hex>"
 *
 * After running this you must restart swf-node — it caches the
 * alchemist list on first read.
 */
const fs   = require("node:fs");
const path = require("node:path");
const os   = require("node:os");
const crypto = require("node:crypto");
const yaml = require("js-yaml");

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const id = args.find(a => !a.startsWith("--")) || os.userInfo().username || "alchemist";

if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
  console.error(`bad id: ${JSON.stringify(id)} — must match /^[a-z0-9][a-z0-9-]{0,31}$/`);
  process.exit(2);
}

// Generate.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

// Extract raw 32-byte pub + 32-byte private seed via JWK.
const pubJwk  = publicKey.export({  format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });
const pubHex  = Buffer.from(pubJwk.x, "base64url").toString("hex");
const seedB64 = privJwk.d;   // 32-byte seed, base64url

const pubField = `ed25519:${pubHex}`;

if (printOnly) {
  console.log(`id:     ${id}`);
  console.log(`pubkey: ${pubField}`);
  console.log(`seed (base64url, KEEP PRIVATE): ${seedB64}`);
  process.exit(0);
}

// 1. Save private seed to repo (gitignored).
const REPO_ROOT = path.resolve(__dirname, "..");
const PRIV_DIR  = path.join(REPO_ROOT, "cohort-data", ".private");
fs.mkdirSync(PRIV_DIR, { recursive: true, mode: 0o700 });
const PRIV_FILE = path.join(PRIV_DIR, `${id}.ed25519.json`);
if (fs.existsSync(PRIV_FILE)) {
  console.error(`refusing to overwrite ${PRIV_FILE} — delete it first if you really want to rotate`);
  process.exit(3);
}
fs.writeFileSync(PRIV_FILE, JSON.stringify({
  id, pubkey: pubField, seed_b64u: seedB64,
  created_at: new Date().toISOString(),
}, null, 2) + "\n", { mode: 0o600 });

// 2. Update / create ~/.config/swf/.alchemists.yml.
const SWF_CFG = path.join(os.homedir(), ".config", "swf");
fs.mkdirSync(SWF_CFG, { recursive: true });
const ALCH_FILE = path.join(SWF_CFG, ".alchemists.yml");
let doc = { schema_version: 1, alchemists: [] };
if (fs.existsSync(ALCH_FILE)) {
  try {
    const existing = yaml.load(fs.readFileSync(ALCH_FILE, "utf8")) || {};
    if (Array.isArray(existing.alchemists)) doc = existing;
  } catch {}
}
doc.alchemists = doc.alchemists || [];
const dup = doc.alchemists.find(a => a.id === id);
if (dup) {
  console.warn(`replacing existing entry for id=${id} (was: ${dup.pubkey})`);
  dup.pubkey = pubField;
} else {
  doc.alchemists.push({ id, pubkey: pubField });
}
fs.writeFileSync(ALCH_FILE,
  yaml.dump(doc, { indent: 2, lineWidth: 1000, sortKeys: false }),
  "utf8");

console.log(`✓ keypair generated for id=${id}`);
console.log(`  pubkey: ${pubField}`);
console.log(`  private: ${PRIV_FILE}`);
console.log(`  alchemists.yml: ${ALCH_FILE}`);
console.log("");
console.log("next:");
console.log("  1. restart swf-node so it picks up the new alchemists list");
console.log("  2. run `npm run publish:cohort` to push cohort-data as bundles");
