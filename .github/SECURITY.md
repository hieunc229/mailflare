# Security policy

## Reporting a vulnerability

Please don't report security vulnerabilities in public issues or pull requests. Report
them privately on GitHub instead: open the **Security** tab and choose
**Report a vulnerability**, or go to
<https://github.com/hieunc229/mailflare/security/advisories/new>.

Include as much of this as you can:

* the Mailflare version (from `package.json`) or the commit you tested
* how it is deployed: Cloudflare Workers, Node.js or Docker
* steps to reproduce, or a proof of concept
* what an attacker can do with it, and what they need first (a mailbox account, an API
  or MCP key, or only the ability to send an email)

All follow-up happens in that private advisory. Once a fix is released, the advisory can
be published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Mailflare is self-hosted and released from `main`. Security fixes only go into the latest
version, so keep your installation up to date with **Update Mailflare** in the admin
dashboard or by redeploying. See
[Updating Mailflare](https://github.com/hieunc229/mailflare/blob/main/docs/deployment.md#updating-mailflare).

## Scope

In scope: the code in this repository, including the Cloudflare Worker, the Node.js
server, the Docker setup, the web app and the API and MCP endpoints.

Out of scope:

* vulnerabilities in Cloudflare, Resend, AWS or other providers; please report those to
  the provider
* spam or phishing that reaches an inbox without exploiting a bug; open a normal issue
* behaviour documented as a design choice in
  [Security notes for inbound mail](https://github.com/hieunc229/mailflare/blob/main/docs/security.md),
  such as attachments not being scanned by an antivirus engine
