import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function generateKeypair(): Keypair {
  return Keypair.generate();
}

export function keypairToBase58Secret(kp: Keypair): string {
  return bs58.encode(kp.secretKey);
}

/** Validate a base58 private key (64-byte secret key) and return its public address. */
export function keypairFromBase58(secretBase58: string): { pubkey: string } {
  const raw = bs58.decode(secretBase58);
  if (raw.length !== 64)
    {throw new Error(`BS58_PRIVATE_KEY invalide : ${raw.length} octets (attendu 64)`);}
  const kp = Keypair.fromSecretKey(raw);
  return { pubkey: kp.publicKey.toBase58() };
}

/** Guard: never re-derive a string that looks like a private key in logs. */
export function shortAddress(pub: string, head = 6, tail = 4): string {
  if (pub.length <= head + tail) {return pub;}
  return `${pub.slice(0, head)}…${pub.slice(-tail)}`;
}
