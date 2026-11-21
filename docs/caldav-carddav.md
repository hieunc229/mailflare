# Calendar and contacts sync (CalDAV and CardDAV)

Mailflare can sync its calendar and contacts in both directions with the Calendar and Contacts apps on your phone or computer, over plain HTTPS. It works on Cloudflare Workers and in the Docker image. Events and contacts you add on a device show up in Mailflare, and the other way round.

It is off until an administrator turns it on.

## Turn it on (administrator)

1. Open **Admin > General** and switch on **Calendar and contacts sync**, then save.
2. Self-hosting on Docker: put a TLS-terminating reverse proxy in front and set `TRUST_PROXY` (see [Self-hosting](self-hosting.md)). Mailflare refuses app passwords over plain HTTP, so a direct, proxy-less install cannot use sync (local development on `localhost` is the exception).
3. Make sure the proxy or firewall passes the WebDAV methods `PROPFIND`, `PROPPATCH`, `REPORT` and `OPTIONS`, plus the `Depth`, `If-Match`, `If-None-Match` and `Authorization` headers.

While the switch is off, every sync address answers 404 and the "Calendar and contacts" choice is hidden when creating an app password. App passwords made earlier stop working while it is off and work again when it is turned back on.

## Create an app password (everyone)

Settings > App passwords shows a **Calendar and contacts sync** section with the addresses to enter in your app. If the switch is off, it says so (and links to the setting if you are an administrator).

1. Choose **Create one** (or fill in the form above it), name the device, and tick **Calendar and contacts (CalDAV and CardDAV)**. No mailbox is needed for this choice.
2. Confirm it is you (password and authenticator code, or a passkey). This step is required because an app password signs in without a second step.
3. Copy the 16-character password. It is shown **once**; if you lose it, revoke it and create another. The list underneath shows when and from where each one was last used, and revokes it at once.

Your account password, passkeys and authenticator codes are never accepted by the sync addresses, only app passwords.

## Addresses

The settings page shows all of these with a copy button next to each:

| What | Address |
|---|---|
| Server address | `https://mail.example.com/dav/` |
| Calendar (CalDAV) | `https://mail.example.com/dav/calendars/<your user id>/default/` |
| Contacts (CardDAV) | `https://mail.example.com/dav/addressbooks/<your user id>/default/` |
| Username | your account email (it is ignored; the password identifies you) |
| Password | the app password |

Most apps only need the server address; the longer ones are for apps that cannot discover the rest. The addresses use `APP_URL` when it is set, otherwise the address you opened the page on. The page warns when that is plain `http:` on anything but `localhost`: iOS, macOS and Mailflare itself need HTTPS, so set `APP_URL` to your HTTPS address.

## Set up your app

### iPhone and iPad

Install the **Apple profile** offered right after you create the password (button **Download Apple profile**): it adds the calendar and contacts accounts in one step. The file is built in your browser and contains the password, so it is never sent to the server. The profile is not signed, so iOS and macOS show it as **Not Verified**; that is expected. On iPhone and iPad, open the download in **Safari** if another browser does not offer it, then go to **Settings > Profile Downloaded** and tap **Install** (some iOS versions show it under General > VPN & Device Management). Delete the downloaded file afterwards. Keep the installed profile: removing it removes the two accounts.

Or by hand: on iOS 18 or later Settings > Apps > Calendar > Calendar Accounts > Add Account > Other > Add CalDAV Account; on iOS 17 and earlier Settings > Calendar > Accounts > Add Account > Other > Add CalDAV Account. Then the same for contacts with Add CardDAV Account (on iOS 18 under Settings > Apps > Contacts > Accounts, before iOS 18 under Settings > Contacts > Accounts). Server: the server address, user name: your email, password: the app password.

### Mac

System Settings > Internet Accounts > Add Other Account > CalDAV Account (and CardDAV Account), choose **Manual**, and enter the server address, your email and the app password. The Apple profile works on macOS as well: open the downloaded file, then **System Settings > Privacy & Security > Profiles**, double-click it and choose **Install** (it shows as Not Verified because it is unsigned).

### Android (DAVx5)

In DAVx5 tap **+**, choose **Login with URL and user name**, enter the server address, your email and the app password. Pick the calendar and address book to sync and turn synchronization on. Any calendar or contacts app on top of DAVx5 then shows the data.

### Thunderbird

- Thunderbird 115 or later, calendar: **New Calendar > On the Network**, enter your email as the user name and the server address as the location, choose **Find Calendars**. Thunderbird discovers the calendars itself and asks for the app password.
- Older versions, or if discovery finds nothing: use the calendar address as the location and format **CalDAV**.
- Contacts: **New Address Book > Add CardDAV Address Book**, user name: your email, location: the contacts address.

### GNOME Evolution and GNOME Online Accounts

Add a CalDAV and a CardDAV account with the server address, your email and the app password.

## What syncs

- **One calendar** named "Mailflare" on the device (renamable there) and **one address book**. Events appear in the Mailflare calendar, reminders, booking availability and the assistant tools.
- **Repeats:** every repeat rule a phone creates shows correctly in Mailflare and on every device. A rule Mailflare's editor cannot express (every 2 weeks, 2nd Tuesday, yearly) shows as "Custom repeat (set in another app)": title, time, place and guests stay editable, the rule is kept. Changing one occurrence on a phone shows that occurrence moved in Mailflare.
- **Invitations** still waiting for an answer, and declined or cancelled events, are not on the device calendar.
- **Contacts** added on the phone with an email address appear on the Contacts page and in composer suggestions; contacts you add in Mailflare appear on the phone. Contacts collected automatically from mail are not pushed to phones.
- Deleting an event on the phone deletes it in Mailflare, without sending cancellation mail.

### Reminders and alarms

Alarms on the phone stay on the phone. An alarm set in an app is kept with the event and shown by that app, but it does **not** make Mailflare send its own push reminder, so you do not get two notifications. Mailflare's own reminders keep working for events that have a Mailflare reminder.

### What Mailflare does not see

The event or contact is stored exactly as the app sent it, and the app always gets it back unchanged, but Mailflare's own screens only show part of it:

| Kept for your apps, not shown or used by Mailflare |
|---|
| Extra alarms, absolute-time alarms, alarms other than display or sound |
| Repeat rules outside the supported set (the event shows once in Mailflare) |
| "Free" (transparent) status: Mailflare treats every event as busy for booking |
| Categories, links, attachments, video-call details, formatted descriptions, guest roles |
| Contact phone numbers, postal addresses, organisation, notes, birthdays, photos and groups (Mailflare shows name and email only; contacts without an email never appear) |

Tasks and journals (VTODO, VJOURNAL, Apple Reminders) are not supported and are refused. Editing an event in Mailflare rewrites the properties Mailflare understands (title, time, place, repeat); everything else is kept.

Limits: 5000 contacts and 20 MB of contacts per user, 50 MB of calendar data, 1 MB per event or card. A write past a limit is refused (507).

## Workers Free plan

The Workers Free plan allows 10 ms of CPU per request. Discovery, listing and later syncs are well inside it. The **first** sync of a large calendar (hundreds or a thousand events) has to build and store each event's body once, and a few of the first requests can hit the limit and fail. Phones retry, and each retry finds more bodies already stored, so the sync completes after a few attempts, and later syncs are cheap. If the phone shows a sync error on the first try, wait a minute and sync again. Paid Workers plans and Docker are not affected.

## Troubleshooting

- **404 on every address:** the administrator has not turned sync on (Admin > General).
- **401 or "wrong password":** use an app password with Calendar and contacts ticked, not your account password; remove spaces if the app complains (spaces and dashes are ignored). A revoked password stops on the next sync.
- **403 "HTTPS is required":** reach Mailflare over https. Behind a reverse proxy on Docker, set `TRUST_PROXY` so its `X-Forwarded-Proto: https` is believed.
- **403 "Calendar is turned off for this account":** your account has the calendar switched off; contacts still sync.
- **429 "Too many attempts" with `Retry-After: 60`:** too many sign-in attempts from one place, usually a wrong or revoked app password. Wait a minute, then try again with the right one.
- **503 with a wait:** the app is syncing too fast (600 requests a minute per password, 120 writes a minute per user). It backs off by itself.
- **Works with a browser but not the app, or answers 403 or 405 from the edge:** Cloudflare Bot Fight Mode, a WAF rule or another proxy is blocking the WebDAV methods. Allow `PROPFIND`, `PROPPATCH`, `REPORT` and `OPTIONS` for `/dav/*` and `/.well-known/caldav` and `/.well-known/carddav`, and let `Depth`, `If-Match`, `If-None-Match` and `Authorization` through. Do not cache these paths.
- **Discovery by domain name:** `/.well-known/caldav` and `/.well-known/carddav` lead to `/dav/`, so most apps need only your domain, email and the app password.

## Checking a server from the command line

`scripts/dav-smoke.mjs` runs a short check against a running instance: discovery, listing the calendar and address book collections, and creating, reading and deleting one test event and one test contact.

```bash
DAV_URL=https://mail.example.com DAV_PASSWORD=<app password> node scripts/dav-smoke.mjs
```

It needs an app password with Calendar and contacts, and deletes what it creates. It refuses plain `http:` for anything but `localhost` and `127.0.0.1`. Real-device interoperability (iOS, macOS, DAVx5, Thunderbird) is tested by hand; please report what you find.
