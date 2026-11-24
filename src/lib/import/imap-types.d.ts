export type ImapImportInput = {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	/** When set, the connection uses SASL XOAUTH2 instead of LOGIN. */
	accessToken?: string;
	folder: string;
	limit: number;
	/** Number of newest messages already imported by earlier batches. */
	offset: number;
};
