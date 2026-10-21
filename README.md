# sello-import

Bring your journal from another app into [Sello](https://sello.voypalante.com), the private journal
whose entries are encrypted on your phone.

It reads an export from **Journey**, **Day One**, a folder of **Markdown or text notes** (Obsidian,
Bear, Notion and most note apps), or any **JSON or CSV** table, and adds every entry to your Sello
journal as a private entry with its original date, tags and photos.

Your entries are encrypted on your computer before anything is sent, with your journal's key, the
same way the Sello web app does it. The server never sees them in the clear.

## What you need

- [Node.js](https://nodejs.org) 20 or newer.
- The Sello app on your phone, signed in to your journal (to approve the sign-in).
- An export from your old app (see below).
- Optional: [ImageMagick](https://imagemagick.org), only for HEIC photos (iPhone), which become JPEG.

```sh
git clone https://github.com/voypalante/sello-import
cd sello-import
npm install
```

## Import in three steps

**1. Convert** your export into a folder you can check:

```sh
node bin/sello-import.mjs convert ~/Downloads/Journey-export.zip
```

The app is detected (or pass `--from journey`, `dayone`, `markdown` or `generic`). This writes a
folder such as `Journey-export-sello/` with `entries.json` and the photos in `files/`. Open
`entries.json` if you want to see or fix anything before uploading.

**2. Upload**, first as a dry run (nothing is sent), then for real:

```sh
node bin/sello-import.mjs upload Journey-export-sello --dry-run
node bin/sello-import.mjs upload Journey-export-sello
```

A QR code appears. In the Sello app, tap the laptop icon at the top and scan it. The app shows a
number: approve with your fingerprint only if it's the same number as in the terminal. Then every
entry is uploaded, with a progress bar. The phone lists the sign-in as "a browser"; it is signed
out when the import ends.

You can run it again at any time: entries already in your journal are skipped, so an interrupted
import picks up where it stopped. Try a few first with `--limit 5` if you like.
If Sello is busy for a moment, the import waits and goes on by itself. If it asks for a longer
wait (many new journals uploading at once, or a lot uploaded in one day), the import stops and
says so: run the same command again later. `--place` adds
where an entry was written (when the export has it) as its last line.

**3. Clean up.** The converted folder holds your journal unencrypted. When your entries look right
in Sello, delete it:

```sh
node bin/sello-import.mjs cleanup Journey-export-sello --yes
```

## Getting the export from your old app

| App | How to export | Notes |
| --- | --- | --- |
| Journey | Settings, Data, Cloud Accounts. A Google account: **Export**, ZIP. A Journey Drive account: **Backup**, then download the ZIP. Both need Journey's paid plan (see below) | HTML formatting becomes Markdown. Journey has no titles; the first sentence is used (`--no-title` leaves them empty). Entries locked with Journey's own encryption are left out and listed |
| Day One | Settings, Export, JSON (a ZIP) | The first line becomes the title, as in Day One (`--no-title` leaves it in the text). Photos and videos keep their place in the text. Audio and PDFs aren't imported |
| Markdown or text | A folder or ZIP of `.md` / `.txt` files, one entry per file | Date from front matter (`date:` or `created:`), else from the file name (`2020-09-13 Sunday.md`), else the file's date. Pictures linked with `![](path)` or `![[name]]` come along |
| Anything else | A JSON list or CSV file, one row per entry | Columns are found by name (`date`, `title`, `body`/`text`/`content`, `tags`, `photos`...). Others: `--map date=When,body=Notes,media=Attachments`. Photo paths are relative to the file, separated by `;` |

**Journey's export is part of its paid plan.** One month is enough: export, check your entries in
Sello, then cancel. Journey's PDF, DOCX and EPUB exports aren't read (EPUB also stops at 1,000
entries); use the ZIP. Without a plan there is no way around it: the Journey app keeps your
photos encrypted on your computer, and only small previews of the ones you've opened are stored
in the clear.

## What gets imported

- Each entry as **private**, with its original date and time.
- Title, text (as Markdown), tags.
- Photos (JPEG, PNG, WebP, GIF, HEIC) and videos (MP4, MOV, WebM). Like the Sello app, the tool
  **removes location and other metadata** from them first. A photo that can't be cleaned isn't
  uploaded.
- Files over your journal's per-file limit (10 MB unless your plan says otherwise) are left out
  and listed at the end.

## Another server

`--server https://your.sello.server` (or `SELLO_SERVER`) imports into a Sello server other than
the official one.

## Adding an app

Each app is one small file in `src/adapters/`. Copy the closest one, list it in
`src/adapters/index.js`, and add a test in `test/adapters.test.js` with a tiny made-up export.
An adapter has:

```js
export default {
  name: 'myapp',
  description: 'My App: the ZIP from Settings > Export',
  detect(src) { /* true if src looks like this app's export */ },
  *read(src, options) {
    // src.names(): every file in the export; src.read(name): its contents as a Buffer.
    yield {
      id: 'stable id from the export',     // the same entry must always get the same id
      date: '2020-09-13T12:26:40Z',        // ISO text, Date, or milliseconds
      title: '',                           // empty: the first sentence is used
      body: 'Markdown text ![](ref-1)',
      tags: ['family'],
      place: 'Panamá',
      media: [{ name: 'photos/a.jpg', ref: 'ref-1' }], // ref: the text in body that stands for it
    };
  },
};
```

Media with a `ref` replace that text in the body; media without one go at the end of the entry.
You can also skip adapters and write `entries.json` yourself (see the format at the top of
`src/entries.js`), then run `upload`.

```sh
npm test
```

## Privacy

- Nothing leaves your computer until you run `upload` and approve it on your phone.
- Entries and files are encrypted here with your journal's key (AES-256-GCM), which your phone
  sends to this program encrypted for it alone. The key is kept in memory and never written to disk.
- The converted folder and your original export are plain copies of your journal. Delete them when
  you're done.

Questions or a format that doesn't import well: sello@voypalante.com, or open an issue.

## License

MIT
