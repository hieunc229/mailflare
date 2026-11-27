/** The id of a user's publish key (spec F9 D-11). Free of server-only imports: the API keys list uses it to recognise the key. */
export const FREEBUSY_KEY_PREFIX = "freebusy_";
export const freeBusyKeyId = (userId: string) => `${FREEBUSY_KEY_PREFIX}${userId}`;
