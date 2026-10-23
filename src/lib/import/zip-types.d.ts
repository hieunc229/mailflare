export interface ZipEntry {
	name: string;
	/** 0 = stored, 8 = deflate. */
	method: number;
	compressedSize: number;
	size: number;
	localHeaderOffset: number;
	encrypted: boolean;
}
