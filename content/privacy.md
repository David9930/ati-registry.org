---
title: Privacy
eyebrow: Legal
draft: true
draft_note: Pending legal review before the registry accepts public registrations.
description: What data the ATI Registry collects, publishes and retains.
---
## What this site collects

- **Registration data you submit** (title, author name, year, ISBN, statement, tools, the role you declare and the other form fields). This becomes a public, permanent record.
- **Your email address.** It is kept private and is never published, sold or used for marketing. It is used to confirm your registration, to send you the private link for managing your record, and to contact you about the record or a report made about it.
- **Reports.** If you report a problem with a record, we keep what you write and the optional email address you give, to handle the report. A report is deleted a year after the maintainers close it.
- **Limited technical data.** To limit automated abuse the registry keeps a salted, one-way hash of your IP address (not the address itself) with a daily counter for about a day. It sets no cookies and loads no analytics scripts.
- **Visit summary.** To email the maintainer a daily summary, the site keeps a short log of page views: the time, the page, the visitor's approximate location (country and state or province, as reported by Cloudflare) and a broad visitor type (browser or known bot). It does not record IP addresses. Entries are deleted once they have been emailed, and in any case after three days.

## Who processes it

The site, its database, the bot check on forms (Cloudflare Turnstile) and the email that confirms registrations are provided by Cloudflare, Inc. and may be processed in several countries. Cloudflare handles technical data, such as IP addresses, under [its own privacy policy](https://www.cloudflare.com/privacypolicy/). If the registry changes email provider, this page will say so.

## Retention

Records are meant to be permanent, like an ISBN record. A withdrawn record stays visible with its status. Your email address is kept while the record exists, so that you can manage it. When the registry removes a record, the stored address, the private management link and the one-way hash used to match your records to your address are all deleted, and the record keeps only its ID, status, label, dates and history. A registration that is never confirmed stops working after 48 hours and is deleted by a daily clean-up, so it is gone within three days at most. Cloudflare keeps short-term point-in-time backups of the database (up to 30 days), and data deleted here can remain in those backups until they expire. Because records are public, copies made by others, and any open-data release made before a record is removed, cannot be recalled. If you ask for personal data to be removed, it will be assessed under the law that applies to you; removing the public history of a declaration may not always be possible. Use the author name exactly as you want it to appear.

## Your choices

You decide what to put in the form. Use your public author name as it appears on the book. You can ask for your email address to be changed or deleted, subject to the above, by writing to the contact address below.

## Contact

Questions about privacy can be sent to {% if cfg.contact_email %}[{{ cfg.contact_email }}](mailto:{{ cfg.contact_email }}){% else %}the contact address on the [About page](/about/){% endif %}.
