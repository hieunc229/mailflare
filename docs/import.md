# Importing from Google Takeout

## Google Calendar

Settings → Import → **Google Takeout: Calendar, Contacts, Drive** imports Google Calendar events, Contacts and Drive files. Pick all Takeout files at once: each card (Calendar, Contacts, Drive) appears when its files are found.

### Get the file

1. Open [Google Takeout](https://takeout.google.com), choose **Deselect all**, then tick **Calendar**.
2. Export once. Google emails a link to one or more `.zip` files.
3. In Mailflare, pick the `.zip` files, or the `.ics` files inside them (one per calendar; your main calendar is named after your Google address).

Files are opened in the browser; only parsed events are uploaded, a few at a time. Keep the tab open. If it stops, pick the same files again: imported events are skipped.

### What the import does

- **One color per calendar.** Mailflare has one calendar per account, so each Google calendar becomes a color. The calendar name is not stored.
- **Preview** counts events and recurring series; imports nothing.
- **Your Google address** (filled in when the file is named after it) is left out of guest lists; declined events are skipped (turn off with *Skip events you declined*).
- **Reminders** are imported when *Import reminders* is on. Only the smallest relative reminder before the start is kept.
- Imported events never email anyone; later edits never send invitations.
- **Re-importing adds nothing twice.** An event is skipped if imported before or already on your calendar as an emailed invitation. Never overwrites: to refresh an event, delete it and import again.

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
| One `.ics` file | 64 MiB |
| Events read from one file | 50,000 (the rest are not read, and the summary says so) |
| One request | Up to 50 series and 500 events (a series and its changed occurrences are one series), 256 KiB from the browser, 1 MiB hard limit, 1,000 events in all |
| One event | 500 changes of the same series, 512 KiB |
| Excluded dates of one series | 1,000 `EXDATE` values (more are ignored), plus one date per cancelled, declined or changed occurrence |
| Title / location | 500 characters |
| Description | 8,000 characters |
| Guests | 100 |

A request the server cannot take is halved and retried, down to single events. Bodies are kept under 1 MiB by encoded size; one event with all its changes still larger is not imported and is counted as too large. On "too many requests" the import waits (the time the server names, else 2, 4 and 8 seconds) and resends. After five tries it stops; choose the same files again later and it continues.

## Google Contacts

### Get the file

1. Open [Google Takeout](https://takeout.google.com), choose **Deselect all**, then tick **Contacts**.
2. Export once and download the `.zip` files. Contacts are `.vcf` files (one per label, plus *All Contacts*).
3. In Mailflare, pick the `.zip` files, or the `.vcf` files inside them. A Google contacts `.csv` (from contacts.google.com → Export → Google CSV) works too, including the older style that starts with the `FF FE` byte order mark. A `.csv` is only offered when its first row looks like a Google contacts header.

Contacts go to the address book of the mailbox selected at the top of the page (the one the Contacts page edits). Only the address book's owner can import: for a shared mailbox you were given access to, the Import button stays off. Files are opened in the browser; only parsed contacts are uploaded, a few at a time. Keep the tab open. If it stops, pick the same files again.

### What the import does

- **One contact per email address.** Contacts are keyed by address: a card with three addresses becomes three contacts, each showing the others under *Other addresses*.
- **Names.** A name you set yourself in the address book is kept. Any other name (for example one learned from mail you received) is replaced by the imported name, and the contact is marked as imported. Importing again may update a name that came from an import, but never one you edited. Imported contacts count as saved contacts: the spam filter and the agent's send review treat them like contacts you added by hand. Blocked contacts stay blocked, and remote-content settings are not touched.
- **Details** (phones, postal addresses, organization, title, birthday, note) are saved with the contact and shown read only in the contact dialog and when you edit a contact. A card with one address and nothing else saves no details. A later import adds the new phones and postal addresses to the stored ones and keeps the organization, birthday and note when the card has none; it never erases details. Only people who can manage the mailbox see the details; read-only delegates see the contact without them.
- **Photos.** *Import photos* (vCard only) uploads a card's embedded picture, only for contacts that have none yet (never your own profile picture), and only when it is a JPEG, PNG, GIF or WebP up to 10 MiB. Pictures are converted in your browser with the same tool as the contact photo form. Picture links in files are never opened, and Google CSV photo columns are ignored. Gravatar is not asked for imported contacts.
- **Preview** counts contacts, with and without an email address; imports nothing.
- **Re-importing changes nothing.** The summary gives contacts added, updated and already up to date.

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
| One `.vcf` or `.csv` file | 64 MiB |
| Contacts read from one file | 50,000 (the rest are not read, and the summary says so) |
| One request | Up to 100 contacts, 256 KiB from the browser, 1 MiB hard limit, 400 addresses in all |
| One contact in a vCard file | 128 KiB of text without its photo |
| Photo | 10 MiB source, up to about 750 KB of base64 per line (larger photos are skipped) |
| Name | 100 characters |

Failed, too-large or rate-limited requests are handled as for the calendar: halved and retried, then counted, or waited out and stopped after five tries.

## Google Drive

### Get the files

1. Open [Google Takeout](https://takeout.google.com), choose **Deselect all**, then tick **Drive**.
2. Export once and download all the `.zip` files. A big Drive comes in several parts; pick them together or one at a time.
3. In Mailflare, pick the `.zip` files. The **Drive** card appears. If your export has several product folders and none is called `Drive`, choose the one that holds your files.

Zips are opened in the browser and each file is sent to your Drive one at a time, in 64 MiB parts (16 MiB on Vercel). Nothing is unzipped on the server. Keep the tab open. If it stops, pick the same files again: finished files are skipped and a half-sent file continues after its last stored part. The already-stored part is re-read from the zip locally (not re-uploaded), so resuming a very large file takes a while before anything new is sent.

### What the import does

- **Folders** are recreated from the paths in the zip (`Takeout/Drive/Taxes/2023/a.pdf` becomes `Taxes/2023/a.pdf`) inside the folder you choose: a new `Google Drive (date)` folder (the default), the top of My Drive, or a folder you already have. Empty folders are created too. An existing folder with the same name is reused.
- **Google Docs, Sheets and Slides** arrive as the `.docx`, `.xlsx` and `.pptx` files Google exported (Takeout's choice of format) and are stored as ordinary files.
- **Already there is skipped.** A file is skipped when the folder already holds a finished file with the same name and the same size. If the folder holds a different file with that name, the new one is stored as `name (1).ext`, up to `(99)`. Name and size are a heuristic: two different files with the same name and size in one folder count as one.
- **Checked as it is read.** Each file's CRC-32 is compared with the zip's directory while it is read; a file that does not match, or that unpacks to a different size than the zip says, is not stored and is reported as corrupt.
- **Content types** come from the file's extension, checked against its first bytes. HTML, SVG, XML, scripts and unknown types are stored as plain downloads, never shown in the browser. Drive serves everything as an attachment unless it is a PDF, an image, plain text or audio and video.
- Modification dates and Takeout's `.json` side files are not kept. Links to Google files (shortcuts) and anything shared with you but not owned by you are not in a Takeout export.

### Storage and limits

| Limit | Value |
| --- | --- |
| Per-user Drive storage | The admin's limit (Settings → General); a file that does not fit stops the import with "Drive storage is full". The card warns first when the files together are larger than the free space. |
| One file | Same as a Drive upload: 10,000 parts x 64 MiB = 625 GiB (about 671 GB); on Vercel 10,000 x 16 MiB = 156 GiB (about 168 GB). The 25 MB and 50 MB limits are for mail attachments and do not apply to Drive. |
| Files in one import | 200,000. Choose fewer zip files at a time for more. |
| Entries in one zip, central directory | 500,000 entries, 64 MiB |
| Folder depth | 24 levels in all, counting the folder you import into and its parents. Files in deeper folders are skipped and counted on the card; the rest of the import goes on |
| Name | 255 characters per folder or file; longer names are not imported |
| One request to the server | Up to 140 files in up to 25 folders, or up to 100 folder paths holding at most 64 distinct folders (ancestors counted); they carry names and sizes only |

Symbolic links, encrypted entries, unusable names (`..`, absolute paths, too long) and junk files (`.DS_Store`, `Thumbs.db`, `__MACOSX`) are not imported; the card counts the ones it skipped. Calendar and contacts files inside the Drive folder stay Drive files.

Names are cleaned before they are used: control characters, text-direction override marks (which can make an `.exe` look like a picture) and zero-width characters are removed, the rest is normalized to NFC, and the Drive name rules apply as for any upload (surrounding spaces are trimmed, runs of spaces become one, `/` and `\` become spaces).

### Requests and daily limits

Every file goes from the browser to your Mailflare server, so a big import is many requests. A small file takes 3 (start, one part, complete); each further part (64 MiB, or 16 MiB on Vercel) adds one. Planning files and folders adds one request per up to 140 files. So 5,000 small files are about 15,000 requests and 50,000 files about 150,000.

On Cloudflare's free plan the limits are 100,000 Worker requests, about 5 million D1 rows read and 100,000 D1 rows written per day. These figures are estimates from reading the code, not measurements:

- Requests: about 33,000 small files a day.
- Rows written: every file adds an item, a row per part and a few updates, so roughly 15,000 files a day.
- Rows read: when the admin has set a per-user storage limit, every upload start sums the size of all the user's Drive items before it stores anything (`getDriveStorageUsed`, one row read per item). This is how the Drive upload works today and this import does not change it. With 10,000 items already in the Drive that is 10,000 rows per file, so about 500 files a day before the free read allowance is used up; with no limit set it does not apply.

One request to plan files uses at most 40 of a Worker's 50 D1 queries (checked by a test), so it never fails for that reason.

The Drive card warns when the chosen folder has more than 5,000 files and offers to import one folder at a time ("Import only this folder"). Importing again is always safe: finished files are skipped, so a run that hits a daily limit can simply be repeated after the limits reset. On a paid plan or your own server these limits do not apply.

A request that gets a server error or "too many requests" (starting, sending a part, completing, planning) is tried up to five times, waiting as long as the server asks (`Retry-After`) or 1 to 8 seconds (2 to 16 for planning). If five files in a row fail to upload, the import stops with a message instead of trying the rest; choose the same files again once the cause is fixed.

## Translations

This screen's text is machine-translated and needs native-speaker review. Corrections welcome as pull requests, see [Adding a language](localization.md).
