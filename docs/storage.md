# Choosing storage

Raw mail, attachments, Drive files, avatars and database backups all live in one place. Pick it before you import a large Google Drive or mailbox, because nothing moves files from one store to another. Switching later leaves the old files behind (copying a bucket by hand with `rclone` is the only route, see [Deployment](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3)).

## What each host can use

| Host | Default | Also works |
| --- | --- | --- |
| Cloudflare Workers | R2 (`BUCKET` binding) | Backblaze B2, AWS S3 |
| Vercel | none, you must pick one | private Vercel Blob store, AWS S3, Backblaze B2 |
| Docker or Node | files under `/data/blobs` | Backblaze B2, AWS S3 |

If B2 and S3 are both configured, B2 wins. A configured S3 or B2 bucket also wins over R2, local files and Vercel Blob.

Only two kinds of endpoint are accepted:

- B2: `B2_ENDPOINT` must look like `s3.<region>.backblazeb2.com`.
- S3: AWS only, always `s3.<region>.amazonaws.com`. There is no endpoint setting.

Other S3-compatible providers (Hetzner, IDrive e2, Wasabi and so on) are not supported today.

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

On Vercel, large uploads go from the browser straight to an S3 or B2 bucket, so the bucket needs a CORS rule. See [Bucket CORS](vercel.md#bucket-cors). Workers and Docker upload through the app and need no rule.
