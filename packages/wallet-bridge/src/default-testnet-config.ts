import type { WalletKitConfig } from "./types.js";

export const SMART_ACCOUNT_KIT_TESTNET_DEFAULTS: WalletKitConfig = {
  rpc_url: "https://soroban-testnet.stellar.org",
  network_passphrase: "Test SDF Network ; September 2015",
  account_wasm_hash: "8537b8166c0078440a5324c12f6db48d6340d157c306a54c5ea81405abcc2611",
  webauthn_verifier_address: "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU",
  ed25519_verifier_address: "CCJOUKLCZVCXS4VIBBEA7S3SPWZQS5DPE5A4YG67RA3Z7E3SJZAUJFQA",
  native_token_contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  threshold_policy_address: "CB2WQXF2XXDGUV2CTVQ23RLN3ESI3IY5KKX3KVXWBNRTTWDHZM76NVKJ",
  spending_limit_policy_address: "CBBZ2XP4LBDEO2EELTZKJSPQZDREFKCULL6CKIUQO53S42RZABOYQUK3",
  weighted_threshold_policy_address: "CCF65VXVORNOZBRR3EG3GZYSFS3ALDG44CDYN5T5KRWKYX6RXLKLXER4",
  rp_id: "localhost",
  rp_name: "OZ Policy Builder",
};
