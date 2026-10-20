import { describe, expect, it } from "vitest";
import { hmacSign } from "@/lib/crypto";
import { extractVariables, renderEmail, renderTemplate, signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/template";

const contact = {
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Acme & Co",
  website: "https://acme.example",
  title: "Engineer",
  customFields: { city: "London" },
};

describe("renderTemplate", () => {
  it("substitutes known variables", () => {
    const out = renderTemplate("Hi {{first_name}} from {{company}}!", {
      first_name: "Ada",
      company: "Acme",
    });
    expect(out).toBe("Hi Ada from Acme!");
  });

  it("renders unknown variables as empty strings (never leaks placeholders)", () => {
    expect(renderTemplate("Hi {{missing_var}}!", {})).toBe("Hi !");
  });

  it("escapes HTML in values (XSS safety)", () => {
    const out = renderTemplate("<b>{{company}}</b>", { company: "<script>alert(1)</script>" });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("supports custom fields", () => {
    expect(renderTemplate("City: {{city}}", { city: "London" })).toBe("City: London");
  });
});

describe("extractVariables", () => {
  it("lists unique variables", () => {
    expect(extractVariables("{{first_name}} {{company}} {{first_name}}")).toEqual(["company", "first_name"]);
  });
});

describe("renderEmail", () => {
  it("renders subject and body with contact data + unsubscribe url", () => {
    const out = renderEmail({
      subject: "Hello {{first_name}}",
      body: "Reach us at {{unsubscribe_url}}",
      contact,
      unsubscribeUrl: "https://app.example/api/unsubscribe?token=x",
    });
    expect(out.subject).toBe("Hello Ada");
    expect(out.html).toContain("https://app.example/api/unsubscribe?token=x");
    expect(out.text.length).toBeGreaterThan(0);
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips a payload", () => {
    const token = signUnsubscribeToken({ c: "contact1", u: "user1", p: "camp1" });
    expect(verifyUnsubscribeToken(token)).toEqual({ c: "contact1", u: "user1", p: "camp1" });
  });

  it("rejects tampered tokens (spec §9: forged unsubscribes must fail)", () => {
    const token = signUnsubscribeToken({ c: "contact1", u: "user1" });
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ c: "victim", u: "user1" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forgedBody}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${body}.AAAA${sig!.slice(4)}`)).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });

  it("rejects payloads without required fields", () => {
    const body = Buffer.from(JSON.stringify({ x: 1 })).toString("base64url");
    const token = `${body}.${hmacSign(body)}`;
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });
});
