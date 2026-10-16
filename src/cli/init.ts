import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { generateKeypair, keypairToBase58Secret, keypairFromBase58 } from "../wallet/create.js";
import { parseEnvFile } from "../utils/env-file.js";

export interface InitResult {
  envPath: string;
  pubkey: string;
  created: boolean;
  qr: string;
}

const ENV_TEMPLATE = [
  "# solbot2 — variables d'environnement (chmod 600, jamais commité)",
  "MODE=paper",
  "# clé privée base58 écrite en tête de fichier par `init`",
  "# JUPITER_API_KEY=",
  "# SOLANA_RPC_URL=",
  "# DASHBOARD_TOKEN=",
  "LOG_LEVEL=info",
  "",
].join("\n");

/**
 * `init` : crée (ou lit) le wallet, écrit le .env chmod 600, affiche l'adresse + QR.
 * Le wallet est généré localement (Keypair.generate), jamais transmis ni loggé.
 */
export async function runInit(rootDir: string, opts: { forceNewWallet?: boolean } = {}): Promise<InitResult> {
  const envPath = path.join(rootDir, ".env");
  if (opts.forceNewWallet || !fs.existsSync(envPath)) {
    const kp = generateKeypair();
    const secret = keypairToBase58Secret(kp);
    const { pubkey } = keypairFromBase58(secret);
    writeEnvFile(envPath, secret);
    return {
      envPath,
      pubkey,
      created: true,
      qr: await QRCode.toString(pubkey, { type: "terminal", small: true }),
    };
  }
  // .env existant: clé déjà présente → on l'affiche simplement
  const data = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  const secret = data["BS58_PRIVATE_KEY"];
  if (!secret) {
    const kp = generateKeypair();
    const secret2 = keypairToBase58Secret(kp);
    const { pubkey: pub2 } = keypairFromBase58(secret2);
    patchKeyInEnv(envPath, secret2);
    return { envPath, pubkey: pub2, created: true, qr: await QRCode.toString(pub2, { type: "terminal", small: true }) };
  }
  const { pubkey } = keypairFromBase58(secret);
  return { envPath, pubkey, created: false, qr: "" };
}

function writeEnvFile(envPath: string, secret: string): void {
  const content = `BS58_PRIVATE_KEY=${secret}\n` + ENV_TEMPLATE.split("\n").slice(1).join("\n");
  fs.writeFileSync(envPath, content, { mode: 0o600, flag: "wx" });
  fs.chmodSync(envPath, 0o600);
}

function patchKeyInEnv(envPath: string, secret: string): void {
  const prior = fs.readFileSync(envPath, "utf8");
  let out: string;
  if (/^BS58_PRIVATE_KEY=.*$/m.test(prior)) {
    out = prior.replace(/^BS58_PRIVATE_KEY=.*$/m, `BS58_PRIVATE_KEY=${secret}`);
  } else {
    out = `BS58_PRIVATE_KEY=${secret}\n${prior}`;
  }
  fs.writeFileSync(envPath, out);
  fs.chmodSync(envPath, 0o600);
}
