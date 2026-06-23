#!/usr/bin/env node
// Generate a fresh EOA keypair for the XMTP gatekeeper bot.
//
//   node selfhost/gen-gatekeeper-key.mjs           # human-readable (key + address)
//   node selfhost/gen-gatekeeper-key.mjs --quiet   # prints only the 0x private key
//
// Set the private key as XMTP_GATEKEEPER_PRIVATE_KEY (gate.env for self-host, or the Vercel
// env), and add the printed ADDRESS as a super-admin of every gated room the bot manages.
// Keep the private key secret — anyone with it controls the gatekeeper.
import { randomBytes } from "node:crypto";

const quiet = process.argv.includes("--quiet");

// 32 random bytes is a valid secp256k1 private key with overwhelming probability.
const privateKey = "0x" + randomBytes(32).toString("hex");

// Address derivation needs viem; print it when viem is resolvable, otherwise tell the user
// how to get it (importing the key into any wallet shows the address).
let address = null;
try {
  const { privateKeyToAccount } = await import("viem/accounts");
  address = privateKeyToAccount(privateKey).address;
} catch {
  /* viem not installed in this context */
}

if (quiet) {
  process.stdout.write(privateKey + "\n");
} else {
  console.log("Chirpy gatekeeper key — KEEP THE PRIVATE KEY SECRET");
  console.log("  XMTP_GATEKEEPER_PRIVATE_KEY=" + privateKey);
  if (address) {
    console.log("  gatekeeper address:         " + address);
  } else {
    console.log("  gatekeeper address:         (install viem to print it, or import the key into a wallet)");
  }
  console.log("");
  console.log("Next:");
  console.log("  1. Set the private key as XMTP_GATEKEEPER_PRIVATE_KEY (gate.env or Vercel env).");
  console.log("  2. Add the gatekeeper address as a super-admin of each gated room.");
}
