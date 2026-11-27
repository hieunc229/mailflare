# Choosing storage

Raw mail, attachments, Drive files, avatars and database backups all live in one place. Pick it before you import a large Google Drive or mailbox, because nothing moves files from one store to another. Switching later leaves the old files behind (copying a bucket by hand with `rclone` is the only route, see [Deployment](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3)).

## What each host can use

| Host | Default | Also works |
| --- | --- | --- |
| Cloudflare Workers | R2 (`BUCKET` binding) | Backblaze B2, AWS S3, any S3-compatible provider |
| Vercel | none, you must pick one | private Vercel Blob store, AWS S3, Backblaze B2, any S3-compatible provider |
| Docker or Node | files under `/data/blobs` | Backblaze B2, AWS S3, any S3-compatible provider |

If B2 and S3 are both configured, B2 wins. A configured S3 or B2 bucket also wins over R2, local files and Vercel Blob.

Endpoints:

- B2: `B2_ENDPOINT` must look like `s3.<region>.backblazeb2.com`.
- AWS S3: no endpoint setting; the host is always `s3.<region>.amazonaws.com`.
- Any other S3-compatible provider: add `S3_ENDPOINT` to the `S3_*` variables, see below.

## S3-compatible providers

Set `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_ENDPOINT`. The provider shows as `s3-compatible` in `GET /api/v1/storage`, which also reports the endpoint and `pathStyle` (never the keys).

- `S3_ENDPOINT` is a host, with or without `https://` and a port. No path, query or credentials. It must be https; `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]` on Docker or Node, for a local MinIO.
- `S3_REGION` is whatever the provider documents (`auto`, `fsn1`, `eu-central-1`). Lowercase letters, digits and hyphens.
- Buckets are addressed as `bucket.endpoint`, so the bucket name must be DNS-safe (lowercase, no dots). Set `S3_FORCE_PATH_STYLE=true` to use `endpoint/bucket` instead, which MinIO and some providers need. Loopback endpoints always use path style. `S3_FORCE_PATH_STYLE` has no effect on AWS S3.
- Requests to a custom endpoint do not follow redirects.
- If B2 is also configured, B2 wins. A wrong `S3_ENDPOINT` never falls back to AWS: the setup is reported as broken.

| Provider | `S3_ENDPOINT` | `S3_REGION` | Docs |
| --- | --- | --- | --- |
| Hetzner Object Storage | `fsn1.your-objectstorage.com` (the location is part of the host; `nbg1` also exists) | `fsn1` | [Hetzner](https://docs.hetzner.com/storage/object-storage/getting-started/using-s3-api-tools) |
| IDrive e2 | the endpoint your dashboard shows for the bucket's region, such as `s3.us-west-1.idrivee2.com`; each account gets its own list | the region code in that host, `us-west-1` | [IDrive e2](https://www.idrive.com/e2/region-endpoints) |
| Wasabi | `s3.eu-central-1.wasabisys.com`: use the host of the bucket's own region, or writes fail | `eu-central-1` | [Wasabi](https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabis-different-storage-regions) |

OVH, Scaleway, DigitalOcean Spaces, MinIO and Cloudflare R2 over S3 use the same variables with the endpoint their docs list. None of these providers has been tested against Mailflare. In particular:

- On Vercel, the browser uploads straight to the bucket with a presigned PUT, so the bucket needs a CORS rule (see below). Whether a provider supports bucket CORS is not verified here. Storj's S3 gateway has no bucket CORS, so it will not work for Vercel direct uploads.
- Drive uploads use multipart upload on the server. Providers that do not implement the S3 multipart API will fail on large files.

Variables and setup: [Workers](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3), [Vercel](vercel.md#storage), [Docker](self-hosting.md#configuration-reference).

## Prices

Read from the providers' pages on 2026-11-28. They change, so check the linked pages before you decide.

| Provider | Storage | Free allowance | Egress | Other |
| --- | --- | --- | --- | --- |
| [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) Standard | $0.015/GB-month | 10 GB-month, 1M Class A and 10M Class B operations a month | free | Class A $4.50 per million, Class B $0.36 per million |
| [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | $6.95/TB-month | first 10 GB | free up to 3x what you store, then $0.01/GB | most API calls free, no minimums |
| [AWS S3](https://aws.amazon.com/s3/pricing/) Standard | see the page | see the page | see the page | per-request charges |
| [Vercel Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing) | Hobby: 1 GB | 10,000 simple and 2,000 advanced operations a month | | going over locks Blob for 30 days |

Vercel Blob is too small for mail on Hobby; the limits are in [Vercel storage](vercel.md#storage).

Monthly cost for storage alone, from the numbers above (operations and AWS not included):

| Stored | R2 | B2 |
| --- | --- | --- |
| 100 GB | about $1.35 | about $0.63 |
| 1 TB | about $14.85 | about $6.88 |
| 10 TB | about $150 | about $69 |

R2 charges for operations beyond the free allowance, which a busy mailbox can pass. B2 is roughly half the price per GB.

## Which one to use

**Cloudflare Workers: R2.** It is already set up, and the first 10 GB is free. Past roughly 100 GB, B2 costs about half as much. B2 is outside Cloudflare's network, so reads are slower than R2, which runs inside it.

**Vercel: B2.** The Blob Hobby limits are too small for mail. S3 also works if you already use AWS.

**Docker or Node: local disk.** It needs no setup and costs nothing but the disk. Use B2 when the server runs out of space.

## Backups

Database backups go into the same store as everything else, under `backups/database`. With local disk that means the backups sit on the server they protect, so copy them elsewhere. Back up the whole volume (see [self-hosting](self-hosting.md#operations)), or point storage at B2 so backups are off-site.

## Bucket CORS

On Vercel, large uploads go from the browser straight to an S3, S3-compatible or B2 bucket, so the bucket needs a CORS rule. See [Bucket CORS](vercel.md#bucket-cors). Workers and Docker upload through the app and need no rule.
