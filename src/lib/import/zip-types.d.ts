export interface ZipEntry {
	name: string;
	/** 0 = stored, 8 = deflate. */
	method: number;
	compressedSize: number;
	size: number;
	localHeaderOffset: number;
	encrypted: boolean;
	/** A unix symbolic link: its content is a path, never file data. */
	isSymlink: boolean;
}
