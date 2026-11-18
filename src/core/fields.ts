// Form fields arrive with whatever names the form used ("Email", "email_address",
// "Work Email"). Lookups ignore case, spaces, dashes and underscores.

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_\-]+/g, "");
}

export function getField(fields: Record<string, string>, name: string): string | undefined {
  const want = normalizeKey(name);
  if (want === "emaildomain") return emailDomain(findEmail(fields)) ?? undefined;
  for (const [k, v] of Object.entries(fields)) {
    if (normalizeKey(k) === want) return v;
  }
  return undefined;
}

export function findEmail(fields: Record<string, string>): string | null {
  const keys = Object.keys(fields);
  const exact = keys.find((k) => /^(work)?e?-?mail(address)?$/.test(normalizeKey(k)));
  const loose = exact ?? keys.find((k) => normalizeKey(k).includes("email"));
  const value = loose ? fields[loose]?.trim() : "";
  return value ? value.toLowerCase() : null;
}

export function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

export function findName(fields: Record<string, string>): string | null {
  const full = getField(fields, "name") ?? getField(fields, "full name");
  if (full) return full;
  const first = getField(fields, "first name") ?? getField(fields, "firstname");
  const last = getField(fields, "last name") ?? getField(fields, "lastname");
  const joined = [first, last].filter(Boolean).join(" ");
  return joined || null;
}

export function findCompany(fields: Record<string, string>): string | null {
  return getField(fields, "company") ?? getField(fields, "company name") ?? getField(fields, "organization") ?? null;
}

/** Free and personal mailbox domains, for the "drop personal emails" option. */
export const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru",
  "zohomail.com", "qq.com", "163.com", "126.com", "comcast.net", "att.net", "verizon.net",
  "hey.com", "fastmail.com", "tutanota.com", "web.de", "free.fr", "orange.fr",
  "hotmail.co.uk", "yahoo.co.uk", "btinternet.com", "rediffmail.com",
]);
