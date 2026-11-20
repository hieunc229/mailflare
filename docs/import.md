# Importing from Google Takeout

## Google Calendar

Settings → Import → **Google Takeout: Calendar, Contacts** brings your Google Calendar events and Google Contacts into Mailflare. Pick all your Takeout files at once: each card (Calendar, Contacts) appears when its files are found.

### Get the file

1. Open [Google Takeout](https://takeout.google.com), choose **Deselect all**, then tick **Calendar**.
2. Export once. Google emails you a link to one or more `.zip` files.
3. In Mailflare, pick the `.zip` files, or the `.ics` files inside them (one per calendar; your main calendar is named after your Google address).

The files are opened in your browser. Only the parsed events are uploaded, a few at a time. Keep the tab open until it finishes. If it stops, pick the same files again: events already imported are skipped.

### What the import does

- **One color per calendar.** Mailflare has a single calendar per account, so each Google calendar becomes a color. The calendar name is not stored.
- **Preview** shows how many events and recurring series are in the file without importing anything.
- **Your Google address** (filled in when the file is named after it) is left out of guest lists, and events you declined are skipped. You can turn that off with *Skip events you declined*.
- **Reminders** are imported when *Import reminders* is on. Only the smallest relative reminder before the start is kept.
- Imported events never email anyone, and later edits of them never send invitations.
- **Importing a file again adds nothing twice.** An event is skipped when it was imported before, or when it already arrived on your calendar as an emailed invitation. Re-importing never overwrites: to refresh an event, delete it and import again.

### What is not carried over

| In Google Calendar | In Mailflare |
| --- | --- |
| All-day events | Imported as midnight to midnight in your time zone. There is no all-day flag. |
| Repeat every N weeks or days, yearly, "second Tuesday", and other rules Mailflare cannot store | Imported as **one event on the first date**. The import summary counts these as simplified. |
| Monthly on the 29th, 30th or 31st | Imported as **one event on the first date**. Google skips a month that has no such day; Mailflare would move the event to the last day of that month, so the two would disagree. |
| A rule with an end date or count that is not valid | Imported as one event on the first date, never as an endless series. A count must be 1 to 10,000. |
| Daily, weekly, weekly on several days, monthly on a date, with an end date or count | Imported as a repeating event. Excluded dates and changed or cancelled occurrences are kept. |
| Several reminders | Only the smallest one. Reminders at an absolute time, or relative to the end, are ignored. |
| Guests | Their addresses, up to 100. Their answers are not kept. |
| Organizer | A line `Organizer: Name <address>` in the description, unless it is you. |
| Google Meet link | One `Join: https://…` line in the description, and the location if it was empty. Only `https` links are kept. |
| Event URL | Added to the description (`https` only). |
| Attachments, categories, visibility, free/busy, custom time zone definitions | Dropped. A time zone Mailflare does not know is read in your time zone, and the summary says how many events that affected. |

HTML in descriptions is turned into plain text. Links in files are never opened.

### Limits

| Limit | Value |
| --- | --- |
| One `.ics` file | 64 MB |
| Events read from one file | 50,000 (the rest are not read, and the summary says so) |
| One request | Up to 50 series and 500 events (a series and its changed occurrences are one series), 256 KB from the browser, 1 MB hard limit, 1,000 events in all |
| One event | 500 changes of the same series, 512 KB |
| Excluded dates of one series | 1,000 `EXDATE` values (more are ignored), plus one date per cancelled, declined or changed occurrence |
| Title / location | 500 characters |
| Description | 8,000 characters |
| Guests | 100 |

A request the server cannot take is split in halves and retried, down to single events. A request body is kept under 1 MB by its encoded size; one event with all its changes that is still larger is not imported and is counted as too large. When the server answers "too many requests", the import waits (for the time the server names, else 2, 4 and 8 seconds) and sends the same request again. After five tries it stops and tells you; choose the same files again later and it continues.

## Google Contacts

### Get the file

1. Open [Google Takeout](https://takeout.google.com), choose **Deselect all**, then tick **Contacts**.
2. Export once and download the `.zip` files. Contacts come as `.vcf` files (one per label, and *All Contacts*).
3. In Mailflare, pick the `.zip` files, or the `.vcf` files inside them. A Google contacts `.csv` (from contacts.google.com → Export → Google CSV) works too, including the older style that starts with the `FF FE` byte order mark. A `.csv` is only offered when its first row looks like a Google contacts header.

Contacts go to the address book of the mailbox selected at the top of the page, the same place the Contacts page edits. For a shared mailbox you need rights to manage it. The files are opened in your browser. Only the parsed contacts are uploaded, a few at a time. Keep the tab open until it finishes. If it stops, pick the same files again.

### What the import does

- **One contact per email address.** Mailflare keys contacts by address, so a card with three addresses becomes three contacts, each showing the card's other addresses under *Other addresses*.
- **Names.** A name you set yourself in the address book is kept. Any other name (for example one learned from mail you received) is replaced by the imported name, and the contact is marked as imported. Importing again may update a name that came from an import, but never one you edited. Imported contacts count as saved contacts: the spam filter and the agent's send review treat them like contacts you added by hand. Blocked contacts stay blocked, and remote-content settings are not touched.
- **Details** (phones, postal addresses, organization, title, birthday, note) are saved with the contact and shown read only in the contact dialog and when you edit a contact. A card with one address and nothing else saves no details. A later import adds the new phones and postal addresses to the stored ones and keeps the organization, birthday and note when the card has none; it never erases details. Only people who can manage the mailbox see the details; read-only delegates see the contact without them.
- **Photos.** *Import photos* (vCard only) uploads a card's embedded picture, only for contacts that have none yet (never your own profile picture), and only when it is a JPEG, PNG, GIF or WebP up to 10 MB. Pictures are converted in your browser with the same tool as the contact photo form. Picture links in files are never opened, and Google CSV photo columns are ignored. Gravatar is not asked for imported contacts.
- **Preview** counts contacts, those with an email address and those without, and imports nothing.
- **Importing a file again changes nothing.** The summary says how many contacts were added, updated and already up to date.

### What is not carried over

| In Google Contacts | In Mailflare |
| --- | --- |
| Contacts without an email address | Not imported. The summary counts them and names the first five. |
| An address that is not a plain `name@domain.tld` | Skipped; the contact's other addresses still import. |
| More than 20 addresses, 20 phones or 10 postal addresses on one card | The first 20, 20 and 10. |
| Phone type labels, postal address labels | Kept as short text (32 characters). |
| Websites, chat accounts, relations, custom fields, labels and groups, nicknames, phonetic names, events other than the birthday | Dropped. |
| Notes | Up to 4,000 characters. |

The details of a contact need a database migration (Admin → Settings). Until it is applied the import answers "Apply pending database migrations", and contacts and mail keep working.

### Limits

| Limit | Value |
| --- | --- |
| One `.vcf` or `.csv` file | 64 MB |
| Contacts read from one file | 50,000 (the rest are not read, and the summary says so) |
| One request | Up to 100 contacts, 256 KB from the browser, 1 MB hard limit, 400 addresses in all |
| One contact in a vCard file | 128 KB of text without its photo |
| Photo | 10 MB source, up to about 750 KB of base64 per line (larger photos are skipped) |
| Name | 100 characters |

Requests that fail, are too large or are rate limited are handled as for the calendar: halved and retried, then counted, or waited out and stopped after five tries.

## Translations

The text of this screen was machine-translated into every language and needs review by native speakers. Corrections are welcome as pull requests, see [Adding a language](localization.md).
