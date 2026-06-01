import { Client, ClientChannel, SFTPWrapper } from "ssh2";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SshConfig } from "./bubble-types";
import type {
	BashOperations,
	ReadOperations,
	WriteOperations,
	EditOperations,
	GrepOperations,
	FindOperations,
	LsOperations,
} from "@earendil-works/pi-coding-agent";

// --- SshConnection ---

export class SshConnection {
	private config: SshConfig;
	private client: Client;
	private sftp: SFTPWrapper | null = null;
	private connected = false;

	constructor(config: SshConfig) {
		this.config = config;
		this.client = new Client();
	}

	async connect(): Promise<void> {
		if (this.connected) return;

		const connectConfig: Record<string, unknown> = {
			host: this.config.host,
			port: this.config.port ?? 22,
			readyTimeout: 15_000,
			tryKeyboard: true,
		};

		if (this.config.user) {
			connectConfig.username = this.config.user;
		}

		const keyPath = this.config.privateKey
			? this.config.privateKey.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~")
			: undefined;

		if (keyPath) {
			try {
				connectConfig.privateKey = fs.readFileSync(keyPath);
			} catch {
				connectConfig.privateKey = this.config.privateKey;
			}
		}

		if (this.config.password) {
			connectConfig.password = this.config.password;
		}

		// Handle keyboard-interactive auth (many servers use this instead of plain password)
		this.client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
			const answers = prompts.map(() => this.config.password ?? "");
			finish(answers);
		});

		await new Promise<void>((resolve, reject) => {
			this.client
				.on("ready", () => {
					this.connected = true;
					resolve();
				})
				.on("error", (err) => {
					reject(err);
				})
				.connect(connectConfig);
		});
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			timeout?: number;
			signal?: AbortSignal;
			onData?: (data: Buffer) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
		this.assertConnected();

		const cwd = options?.cwd ?? this.config.remoteCwd;
		const fullCommand = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;

		return new Promise((resolve, reject) => {
			let settled = false;
			let activeStream: ClientChannel | null = null;
			let timer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
			};

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				activeStream?.close();
				reject(new Error("Aborted"));
			};

			options?.signal?.addEventListener("abort", onAbort);

			if (options?.timeout) {
				timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					activeStream?.close();
					reject(new Error(`Command timed out after ${options.timeout}ms`));
				}, options.timeout);
			}

			this.client.exec(fullCommand, (err, stream: ClientChannel) => {
				if (err) {
					if (settled) return;
					settled = true;
					cleanup();
					reject(err);
					return;
				}

				activeStream = stream;

				let stdout = "";
				let stderr = "";

				stream
					.on("data", (data: Buffer) => {
						stdout += data.toString();
						options?.onData?.(data);
					})
					.on("stderr", (data: Buffer) => {
						stderr += data.toString();
					})
					.on("close", (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve({ stdout, stderr, exitCode: code });
					});
			});
		});
	}

	async getSftp(): Promise<SFTPWrapper> {
		if (this.sftp) return this.sftp;

		return new Promise((resolve, reject) => {
			this.client.sftp((err, sftp) => {
				if (err) reject(err);
				else {
					this.sftp = sftp;
					resolve(sftp);
				}
			});
		});
	}

	async readFile(remotePath: string): Promise<Buffer> {
		const sftp = await this.getSftp();
		const chunks: Buffer[] = [];

		return new Promise((resolve, reject) => {
			const stream = sftp.createReadStream(remotePath);
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", reject);
		});
	}

	async writeFile(remotePath: string, content: string | Buffer): Promise<void> {
		const sftp = await this.getSftp();

		const dir = path.posix.dirname(remotePath);
		await this.ensureDir(dir);

		return new Promise((resolve, reject) => {
			const stream = sftp.createWriteStream(remotePath);
			stream.on("finish", resolve);
			stream.on("error", reject);
			stream.end(content);
		});
	}

	async stat(remotePath: string): Promise<{ isDirectory: () => boolean }> {
		const sftp = await this.getSftp();

		return new Promise((resolve, reject) => {
			sftp.stat(remotePath, (err, stats) => {
				if (err) reject(err);
				else resolve({ isDirectory: () => stats.isDirectory() });
			});
		});
	}

	async readdir(remotePath: string): Promise<string[]> {
		const sftp = await this.getSftp();

		return new Promise((resolve, reject) => {
			sftp.readdir(remotePath, (err, list) => {
				if (err) reject(err);
				else resolve(list.map((item) => item.filename));
			});
		});
	}

	async access(remotePath: string): Promise<void> {
		const result = await this.exec(`test -e ${shellEscape(remotePath)}`);
		if (result.exitCode !== 0) {
			throw new Error(`Path not accessible: ${remotePath}`);
		}
	}

	async exists(remotePath: string): Promise<boolean> {
		const result = await this.exec(`test -e ${shellEscape(remotePath)}`);
		return result.exitCode === 0;
	}

	async isDirectory(remotePath: string): Promise<boolean> {
		const result = await this.exec(`test -d ${shellEscape(remotePath)}`);
		return result.exitCode === 0;
	}

	private async ensureDir(dir: string): Promise<void> {
		await this.exec(`mkdir -p ${shellEscape(dir)}`);
	}

	disconnect(): void {
		if (this.sftp) {
			this.sftp.end();
			this.sftp = null;
		}
		if (this.connected) {
			this.client.end();
			this.connected = false;
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	private assertConnected(): void {
		if (!this.connected) {
			throw new Error("SSH connection not established");
		}
	}
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// --- Operations Implementations ---

export interface SshOperationsSet {
	bash: BashOperations;
	read: ReadOperations;
	write: WriteOperations;
	edit: EditOperations;
	grep: GrepOperations;
	find: FindOperations;
	ls: LsOperations;
}

export function createSshOperations(conn: SshConnection): SshOperationsSet {
	const bash: BashOperations = {
		exec: async (command, cwd, options) => {
			const result = await conn.exec(command, {
				cwd,
				onData: options.onData,
				signal: options.signal,
				timeout: options.timeout,
				env: options.env,
			});
			return { exitCode: result.exitCode };
		},
	};

	const read: ReadOperations = {
		readFile: (absolutePath) => conn.readFile(absolutePath),
		access: (absolutePath) => conn.access(absolutePath),
		detectImageMimeType: async (absolutePath) => {
			const ext = path.posix.extname(absolutePath).toLowerCase();
			const mimeMap: Record<string, string> = {
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".gif": "image/gif",
				".webp": "image/webp",
				".svg": "image/svg+xml",
				".bmp": "image/bmp",
				".ico": "image/x-icon",
			};
			return mimeMap[ext] ?? null;
		},
	};

	const write: WriteOperations = {
		writeFile: (absolutePath, content) => conn.writeFile(absolutePath, content),
		mkdir: (dir) => conn.exec(`mkdir -p ${shellEscape(dir)}`).then(() => {}),
	};

	const edit: EditOperations = {
		readFile: (absolutePath) => conn.readFile(absolutePath),
		writeFile: (absolutePath, content) => conn.writeFile(absolutePath, content),
		access: (absolutePath) => conn.access(absolutePath),
	};

	const grep: GrepOperations = {
		isDirectory: (absolutePath) => conn.isDirectory(absolutePath),
		readFile: async (absolutePath) => {
			const buf = await conn.readFile(absolutePath);
			return buf.toString("utf-8");
		},
	};

	const find: FindOperations = {
		exists: (absolutePath) => conn.exists(absolutePath),
		glob: async (pattern, cwd, options) => {
			const ignoreArgs = (options.ignore ?? [])
				.map((i) => `-not -path ${shellEscape(i)}`)
				.join(" ");
			const cmd = `find ${shellEscape(cwd)} -name ${shellEscape(pattern)} ${ignoreArgs} -type f 2>/dev/null | head -n ${options.limit ?? 1000}`;
			const result = await conn.exec(cmd);
			return result.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		},
	};

	const ls: LsOperations = {
		exists: (absolutePath) => conn.exists(absolutePath),
		stat: (absolutePath) => conn.stat(absolutePath),
		readdir: (absolutePath) => conn.readdir(absolutePath),
	};

	return { bash, read, write, edit, grep, find, ls };
}
