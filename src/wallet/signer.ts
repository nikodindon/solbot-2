import type { VersionedTransaction } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { keypairFromBase58 } from "./create.js";

/** Signer abstraction: only what we need for the Meta-Aggregator flow. */
export interface Signer {
  readonly pubkey: string;
  signVersioned(tx: VersionedTransaction): VersionedTransaction;
}

export class EnvSigner implements Signer {
  private readonly kp: Keypair;
  readonly pubkey: string;

  constructor(secretBase58: string) {
    const { pubkey } = keypairFromBase58(secretBase58);
    this.pubkey = pubkey;
    const raw = bs58.decode(secretBase58);
    if (raw.length !== 64) {throw new Error("BS58_PRIVATE_KEY invalide");}
    this.kp = Keypair.fromSecretKey(raw);
  }

  signVersioned(tx: VersionedTransaction): VersionedTransaction {
    tx.sign([this.kp]);
    return tx;
  }
}
