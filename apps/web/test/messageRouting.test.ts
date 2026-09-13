import { describe, expect, it } from "vitest";
import { parseRecipient, emailComposeUrl, walletChatLink, recipientFromFragment } from "../src/messageRouting";
const wallet = `0x${"ab".repeat(20)}`;
describe("message destination boundaries", () => {
  it("distinguishes email, wallet and ENS without any network lookup", () => {
    expect(parseRecipient(wallet)).toEqual({ kind: "wallet", value: wallet });
    expect(parseRecipient(" Alice.ETH ")).toEqual({ kind: "ens", value: "alice.eth" });
    expect(parseRecipient("Alice+tag@EXAMPLE.COM")).toEqual({ kind: "email", value: "Alice+tag@example.com" });
  });
  it.each(["a@example.com?bcc=bad@example.com", "a@example.com\r\nBcc:b@example.com", "a%0d%0a@example.com", "Alice <a@example.com>", "a@example.com,b@example.com", "mailto:a@example.com", "javascript:alert(1)", "a@-example.com", "a..b@example.com", "a@localhost", "a@exam_ple.com", "a".repeat(65)+"@example.com", wallet+"\n"])("rejects ambiguous or injected recipient %s", value => {
    expect(parseRecipient(value)).toBeNull();
    expect(emailComposeUrl(value)).toBeNull();
  });
  it("encodes email metacharacters without permitting extra mailto fields", () => {
    const url = emailComposeUrl("a#b&c@example.com");
    expect(url).toBe("mailto:a%23b%26c%40example.com");
    expect(emailComposeUrl(wallet)).toBeNull();
  });
  it("uses fragment-only invitations and refuses email identity substitution", () => {
    const link = walletChatLink("https://chirpy.bittrees.org/?secret=remove", wallet)!;
    expect(new URL(link).search).toBe("");
    expect(recipientFromFragment(new URL(link).hash)).toBe(wallet);
    expect(walletChatLink("https://chirpy.bittrees.org", "a@example.com")).toBeNull();
    expect(walletChatLink("http://chirpy.bittrees.org", wallet)).toBeNull();
    expect(walletChatLink("https://user:pass@chirpy.bittrees.org", wallet)).toBeNull();
  });
  it.each([`#to=${wallet}&to=${wallet}`, `#to=${wallet}&body=send`, "#to=alice%40example.com", "#to=javascript:alert(1)", "#to=%0a", "#to="+"x".repeat(1024)])("rejects untrusted invitation %s", fragment => {
    expect(recipientFromFragment(fragment)).toBeNull();
  });
});
