import { readFileSync } from "node:fs";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

// Synthetic localhost credentials, used only by tests and the local harness.
export const localhostCertificatePath = new URL(
  "./localhost-cert.pem",
  import.meta.url,
);

export const localhostTls = {
  cert: readFileSync(localhostCertificatePath),
  key: readFileSync(new URL("./localhost-key.pem", import.meta.url)),
};

export function trustLocalhostCertificate(): () => void {
  const originalCertificates = getCACertificates("default");
  setDefaultCACertificates([...originalCertificates, localhostTls.cert]);
  return () => setDefaultCACertificates(originalCertificates);
}
