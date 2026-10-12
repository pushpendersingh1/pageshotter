# Security

PageShotter runs inside the pages people capture, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Instead, use GitHub's private reporting: open this
repository's **Security** tab and choose **Report a vulnerability**. Only the maintainer can see the
report. If you cannot use GitHub, write to support@pageshotter.com with "Security" in the subject.

Helpful to include: what an attacker can do, the steps or a page that reproduces it, and the
PageShotter version (shown on `chrome://extensions`).

You can expect an acknowledgement within a few days. Once a fix is published to the Chrome Web
Store, the report can be disclosed, with credit if you would like it.

## Supported versions

Only the latest version published on the Chrome Web Store receives fixes.

## In scope

- Anything that lets a web page read, alter or exfiltrate a capture, history or settings.
- Code execution in an extension page, or a way to make the extension load remote code.
- A capture or export that leaves the device.
- A page mutation the extension fails to undo after a capture.

Reports about the website, pageshotter.com, are welcome at the same address.
