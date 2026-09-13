import React from "react";
import { messageParts } from "../messageLinks";

/** Keep React text escaping and never load previews for private notification URLs. */
export function MessageBody({ body }: { body: string }) {
  return <span className="msg-body">{messageParts(body).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{part.text}</a>
    : <React.Fragment key={index}>{part.text}</React.Fragment>)}</span>;
}
