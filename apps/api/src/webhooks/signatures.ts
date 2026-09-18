import { createHmac, timingSafeEqual } from "node:crypto";

export function validarFirmaTwilio(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
): boolean {
  if (!authToken || !signatureHeader) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validarFirmaMeta(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
