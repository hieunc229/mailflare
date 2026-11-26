/*
 * Direct uploads, used on Vercel only: a function there refuses request bodies over 4.5 MB, so the client puts
 * the body in object storage with a presigned URL and sends the request empty, naming the object.
 */

/** Where the stored bodies live: `request-uploads/<owner>/<uuid>`. */
export const REQUEST_UPLOAD_PREFIX = "request-uploads";
/** Names the stored object that holds this request's body. */
export const UPLOAD_KEY_HEADER = "x-mailflare-upload";
/** The Content-Type that body was serialized with. */
export const UPLOAD_TYPE_HEADER = "x-mailflare-upload-type";
/** The owner of messages the email relay uploads; no user id can collide with it. */
export const RELAY_UPLOAD_OWNER = "relay";
/** Bodies above this go through storage. Leaves headroom under Vercel's 4.5 MB. */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 4_000_000;
/** The largest body any route accepts this way (a backup restore). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
