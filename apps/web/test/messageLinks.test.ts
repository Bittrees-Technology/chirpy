import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { messageParts } from "../src/messageLinks";
import { MessageBody } from "../src/views/MessageBody";

const notification = "https://mercado.bittrees.org/account/notifications/opaque-id";
describe("plain-text HTTPS message links", () => {
  it("links Mercado notifications while preserving exact message text", () => {
    const text = `A private-offer update is available. Sign in to review: ${notification}.`;
    const parts = messageParts(text);
    expect(parts.filter(p => p.href)).toEqual([{ text: notification, href: notification }]);
    expect(parts.map(p => p.text).join("")).toBe(text);
  });
  it.each([
    "javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://example.com",
    "file:///tmp/private", "mailto:member@example.com", "//example.com", "javascript:https://example.com",
    "https%3A%2F%2Fexample.com", "https://user:pass@example.com", "https://mercado.bittrees.org@evil.example",
    "https://evil.example\\@mercado.bittrees.org", "https://", "https://example.com/%zz",
    "https://example.com/\u202eevil", "https://example.com/" + "x".repeat(2048),
    '<a href="https://evil.example">Mercado</a>',
  ])("keeps unsupported or misleading input as escaped text: %s", text => {
    expect(messageParts(text).every(p => !p.href)).toBe(true);
    expect(messageParts(text).map(p => p.text).join("")).toBe(text);
  });
  it("handles multiple URLs, newlines and parentheses without losing punctuation", () => {
    const text = `(https://example.com/a)\nhttps://example.com/b_(c). Next https://example.com/d?q=a%26b#section`;
    const parts = messageParts(text);
    expect(parts.map(p => p.text).join("")).toBe(text);
    expect(parts.filter(p => p.href).map(p => p.text)).toEqual([
      "https://example.com/a", "https://example.com/b_(c)", "https://example.com/d?q=a%26b#section",
    ]);
  });
  it("bounds link elements and leaves oversized tokens as text", () => {
    const text = (notification + " ").repeat(1000) + "https://example.com/" + ".".repeat(50000) + "x";
    const parts = messageParts(text);
    expect(parts.filter(p => p.href)).toHaveLength(100);
    expect(parts.map(p => p.text).join("")).toBe(text);
    expect(messageParts("https://example.com/" + ".".repeat(50000) + "x").every(p => !p.href)).toBe(true);
  });
  it("renders links with isolation and no HTML, images, previews or decoded payloads", () => {
    const text = `<img src=x onerror=alert(1)> ${notification}?q=%3Cscript%3Ealert(1)%3C/script%3E <script>alert(2)</script>`;
    const node = document.createElement("div");
    node.innerHTML = renderToStaticMarkup(React.createElement(MessageBody, { body: text }));
    expect(node.textContent).toBe(text);
    expect(node.querySelectorAll("img,script,iframe,video,link")).toHaveLength(0);
    const link = node.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`${notification}?q=%3Cscript%3Ealert(1)%3C/script%3E`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerPolicy")).toBe("no-referrer");
  });
});
